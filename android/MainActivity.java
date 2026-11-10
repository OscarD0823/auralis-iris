package io.github.oscard0823.auralisiris;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String HOST = "iris.auralis.invalid";
    private static final String HOME = "https://" + HOST + "/";
    private static final int PICK_PHOTOS = 1;
    private static final int CAPTURE = 2;
    private static final int SAVE_FILE = 3;
    private static final int CAMERA_PERMISSION = 4;
    private static final int QR_PERMISSION = 5;
    private static final int GRANT_FILE = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final long MAX_EXPORT = 512L * 1024 * 1024;
    private static final Map<String, String> ASSET_HEADERS = new HashMap<>();

    static {
        ASSET_HEADERS.put("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; "
                + "style-src 'self' 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
        ASSET_HEADERS.put("X-Content-Type-Options", "nosniff");
        ASSET_HEADERS.put("Cache-Control", "no-store");
    }

    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private WebView web;
    private ValueCallback<Uri[]> picker;
    private File cameraFile;
    private File saving;
    private PermissionRequest qrPermission;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        files.execute(() -> IrisFiles.clean(this));

        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.rgb(16, 47, 42));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        container.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getStableInsetLeft(), insets.getStableInsetTop(),
                        insets.getStableInsetRight(), insets.getStableInsetBottom());
            }
            return insets;
        });

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "IrisAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                Uri url = request.getUrl();
                if (isHome(url)) return false;
                if (request.hasGesture() && "https".equals(url.getScheme()) && "github.com".equals(url.getHost())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (RuntimeException ignored) {
                        // No browser is available.
                    }
                }
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!isHome(url)) return LanProxy.message(403, "Solicitud bloqueada.");
                String path = url.getPath();
                if (path != null && path.startsWith("/__iris_lan/")) {
                    return request.isForMainFrame() ? LanProxy.message(403, "Solicitud bloqueada.") : LanProxy.fetch(MainActivity.this, request);
                }
                return localAsset(url);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picker != null || saving != null) {
                    callback.onReceiveValue(null);
                    return true;
                }
                picker = callback;
                if (params.isCaptureEnabled()) {
                    if (cameraAllowed()) takePhoto();
                    else requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
                } else {
                    chooseImages(params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                }
                return true;
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    String[] resources = request.getResources();
                    if (!isHome(request.getOrigin()) || resources.length != 1 ||
                            !PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0]) || qrPermission != null) {
                        request.deny();
                    } else if (cameraAllowed()) {
                        request.grant(resources);
                    } else {
                        qrPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, QR_PERMISSION);
                    }
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == qrPermission) qrPermission = null;
            }
        });
        container.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(container);
        web.loadUrl(HOME);
    }

    private static boolean isHome(Uri url) {
        return "https".equals(url.getScheme()) && HOST.equals(url.getEncodedAuthority());
    }

    private WebResourceResponse localAsset(Uri url) {
        String path = url.getPath();
        String asset = path == null || path.length() <= 1 ? "index.html" : path.substring(1);
        if (!asset.matches("(?:vendor/)?[a-zA-Z0-9_.-]+") || asset.contains("..")) {
            return LanProxy.message(404, "Archivo no encontrado.");
        }
        String mime;
        switch (asset.substring(asset.lastIndexOf('.') + 1)) {
            case "html": mime = "text/html"; break;
            case "js": mime = "text/javascript"; break;
            case "css": mime = "text/css"; break;
            case "svg": mime = "image/svg+xml"; break;
            case "png": mime = "image/png"; break;
            case "webmanifest": mime = "application/manifest+json"; break;
            default: mime = "text/plain";
        }
        try {
            InputStream stream = getAssets().open("web/" + asset);
            return new WebResourceResponse(mime, mime.startsWith("text/") ? "UTF-8" : null, 200, "OK", ASSET_HEADERS, stream);
        } catch (IOException e) {
            return LanProxy.message(404, "Archivo no encontrado.");
        }
    }

    private boolean cameraAllowed() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void takePhoto() {
        try {
            cameraFile = IrisFiles.create(this, "Captura.jpg");
            Uri output = IrisFiles.uri(cameraFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
            intent.setClipData(ClipData.newRawUri("Captura", output));
            intent.addFlags(GRANT_FILE);
            startActivityForResult(intent, CAPTURE);
        } catch (IOException | RuntimeException e) {
            IrisFiles.discard(cameraFile);
            cameraFile = null;
            chooseImages(false);
        }
    }

    private void chooseImages(boolean multiple) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        try {
            startActivityForResult(intent, PICK_PHOTOS);
        } catch (RuntimeException e) {
            finishPicker(null);
            Toast.makeText(this, "No se pudo abrir el selector de fotos.", Toast.LENGTH_SHORT).show();
        }
    }

    private void finishPicker(Uri[] result) {
        ValueCallback<Uri[]> callback = picker;
        picker = null;
        if (callback != null) callback.onReceiveValue(result);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        boolean allowed = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == CAMERA_PERMISSION) {
            if (allowed) takePhoto();
            else {
                finishPicker(null);
                Toast.makeText(this, "Activa el permiso de cámara para tomar fotos.", Toast.LENGTH_SHORT).show();
            }
        } else if (code == QR_PERMISSION && qrPermission != null) {
            if (allowed) qrPermission.grant(qrPermission.getResources());
            else qrPermission.deny();
            qrPermission = null;
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == CAPTURE) {
            File photo = cameraFile;
            cameraFile = null;
            Uri uri = photo == null ? null : IrisFiles.uri(photo);
            if (uri != null) revokeUriPermission(uri, GRANT_FILE);
            if (result == RESULT_OK && photo != null && photo.length() > 0) finishPicker(new Uri[]{uri});
            else {
                IrisFiles.discard(photo);
                finishPicker(null);
            }
        } else if (code == PICK_PHOTOS) {
            ArrayList<Uri> photos = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                ClipData selected = data.getClipData();
                if (selected != null) {
                    for (int i = 0; i < selected.getItemCount(); i++) {
                        Uri uri = selected.getItemAt(i).getUri();
                        if (uri != null && "content".equals(uri.getScheme())) photos.add(uri);
                    }
                } else if (data.getData() != null && "content".equals(data.getData().getScheme())) photos.add(data.getData());
            }
            finishPicker(photos.isEmpty() ? null : photos.toArray(new Uri[0]));
        } else if (code == SAVE_FILE && saving != null) {
            Uri destination = result == RESULT_OK && data != null ? data.getData() : null;
            if (destination == null) finishSave("cancelled");
            else files.execute(() -> saveTo(destination, saving));
        }
    }

    private void saveTo(Uri destination, File file) {
        try (OutputStream stream = getContentResolver().openOutputStream(destination, "w")) {
            if (stream == null) throw new IOException("No destination stream");
            java.nio.file.Files.copy(file.toPath(), stream);
        } catch (IOException | RuntimeException e) {
            try {
                DocumentsContract.deleteDocument(getContentResolver(), destination);
            } catch (IOException | RuntimeException ignored) {
                // The selected provider may not support deleting the partial output.
            }
            runOnUiThread(() -> finishSave("error"));
            return;
        }
        runOnUiThread(() -> finishSave("saved"));
    }

    private void finishSave(String result) {
        File file = saving;
        saving = null;
        IrisFiles.discard(file);
        exportResult(IrisFiles.id(file), result);
    }

    private void exportResult(String id, String result) {
        if (!isDestroyed()) web.evaluateJavascript(
                "dispatchEvent(new CustomEvent('iris-android-export',{detail:[" + JSONObject.quote(id) + "," +
                        JSONObject.quote(result) + "]}))", null);
    }

    private void exportFile(String id, boolean share) {
        File file = IrisFiles.find(this, id);
        if (file == null || file.length() == 0 || saving != null || picker != null) {
            IrisFiles.discard(file);
            exportResult(id, "error");
            return;
        }
        String type = IrisFiles.type(file.getName());
        try {
            if (share) {
                Uri uri = IrisFiles.uri(file);
                Intent send = new Intent(Intent.ACTION_SEND).setType(type);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.setClipData(ClipData.newRawUri(file.getName(), uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, "Compartir archivo"));
                exportResult(id, "shared");
            } else {
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(type);
                create.addCategory(Intent.CATEGORY_OPENABLE);
                create.putExtra(Intent.EXTRA_TITLE, file.getName());
                saving = file;
                startActivityForResult(create, SAVE_FILE);
            }
        } catch (RuntimeException e) {
            saving = null;
            IrisFiles.discard(file);
            exportResult(id, "error");
        }
    }

    private final class Bridge {
        @JavascriptInterface public String startFile(String name) {
            try {
                return IrisFiles.id(IrisFiles.create(MainActivity.this, name));
            } catch (IOException | RuntimeException e) {
                return "";
            }
        }

        @JavascriptInterface public boolean appendFile(String id, String encoded) {
            File file = IrisFiles.find(MainActivity.this, id);
            if (file == null || encoded.length() > 262144) return false;
            try {
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (file.length() + bytes.length > MAX_EXPORT) return false;
                try (FileOutputStream out = new FileOutputStream(file, true)) {
                    out.write(bytes);
                }
                return true;
            } catch (IOException | RuntimeException e) {
                return false;
            }
        }

        @JavascriptInterface public void discardFile(String id) {
            IrisFiles.discard(IrisFiles.find(MainActivity.this, id));
        }

        @JavascriptInterface public void exportFile(String id, boolean share) {
            runOnUiThread(() -> MainActivity.this.exportFile(id, share));
        }
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); return !!d; })()",
                result -> { if (!"true".equals(result)) finish(); });
    }

    @Override protected void onDestroy() {
        files.shutdown();
        web.removeJavascriptInterface("IrisAndroid");
        web.destroy();
        super.onDestroy();
    }
}
