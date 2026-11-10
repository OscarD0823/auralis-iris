package io.github.oscard0823.auralisiris;

import android.content.Context;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class LanProxy {
    private static final int MAX_FILE = 40 * 1024 * 1024;
    private static final String[] PARCEL_HEADERS = {"X-Iris-ID", "X-Iris-Name", "X-Iris-Quad"};
    private static final String[] STATUS_HEADERS = {"X-Iris-Online", "X-Iris-Pending"};

    static WebResourceResponse fetch(Context context, WebResourceRequest request) {
        List<String> path = request.getUrl().getPathSegments();
        Map<String, String> headers = request.getRequestHeaders();
        String method = header(headers, "X-Iris-Method");
        String key = header(headers, "Authorization");
        if (!"GET".equals(request.getMethod()) || path.size() != 3 || !localAddress(path.get(1))
                || !allowed(method, path.get(2)) || !key.matches("Bearer [0-9a-f]{48}")) {
            return message(403, "Enlace de red local no válido.");
        }

        String endpoint = path.get(2);
        String type = header(headers, "Content-Type");
        File upload = null;
        if ("POST".equals(method) && "inbox".equals(endpoint)) {
            upload = IrisFiles.find(context, header(headers, "X-Iris-Upload"));
            if (upload == null || upload.length() <= 0 || upload.length() > MAX_FILE
                    || !type.equals(IrisFiles.type(upload.getName())) || !binary(type)) {
                return message(400, "Archivo no válido para el envío.");
            }
        }

        HttpURLConnection relay = null;
        try {
            String origin = "http://" + path.get(1);
            relay = (HttpURLConnection) new URL(origin + "/api/" + endpoint).openConnection(Proxy.NO_PROXY);
            relay.setConnectTimeout(5000);
            relay.setReadTimeout(25000);
            relay.setInstanceFollowRedirects(false);
            relay.setRequestMethod(method);
            relay.setRequestProperty("Origin", origin);
            relay.setRequestProperty("Authorization", key);
            relay.setRequestProperty("Accept-Encoding", "identity");
            for (String name : PARCEL_HEADERS) {
                String value = header(headers, name);
                if (!value.isEmpty()) relay.setRequestProperty(name, value);
            }
            if (upload != null) {
                relay.setDoOutput(true);
                relay.setRequestProperty("Content-Type", type);
                relay.setFixedLengthStreamingMode(upload.length());
                try (OutputStream out = relay.getOutputStream()) {
                    Files.copy(upload.toPath(), out);
                }
            }
            int code = relay.getResponseCode();
            if (code < 200 || (code >= 300 && code < 400) || code > 599) throw new IOException("Unexpected status");
            String mime = relay.getContentType();
            mime = mime == null ? "text/plain" : mime.split(";", 2)[0];
            long length = relay.getContentLengthLong();
            if ((binary(mime) && (length <= 0 || length > MAX_FILE)) || length > MAX_FILE) {
                throw new IOException("Unexpected size");
            }
            if (!binary(mime) && !"application/json".equals(mime)) mime = "text/plain";
            Map<String, String> reply = new HashMap<>();
            reply.put("Cache-Control", "no-store");
            reply.put("X-Content-Type-Options", "nosniff");
            for (String name : PARCEL_HEADERS) copyHeader(relay, reply, name);
            for (String name : STATUS_HEADERS) copyHeader(relay, reply, name);
            InputStream data = code >= 400 ? relay.getErrorStream() : relay.getInputStream();
            if (!binary(mime)) {
                byte[] body = new byte[4096];
                int used = 0;
                if (data != null) {
                    try (InputStream input = data) {
                        while (used < body.length) {
                            int count = input.read(body, used, body.length - used);
                            if (count < 0) break;
                            used += count;
                        }
                    }
                }
                relay.disconnect();
                return new WebResourceResponse(mime, "UTF-8", code, "Iris", reply, new ByteArrayInputStream(body, 0, used));
            }
            if (data == null) throw new IOException("Missing file");
            HttpURLConnection connection = relay;
            InputStream stream = new FilterInputStream(data) {
                @Override public void close() throws IOException {
                    try {
                        super.close();
                    } finally {
                        connection.disconnect();
                    }
                }
            };
            return new WebResourceResponse(mime, null, code, "Iris", reply, stream);
        } catch (IOException | RuntimeException e) {
            if (relay != null) relay.disconnect();
            return message(502, "No se pudo contactar al PC en la red local.");
        }
    }

    private static boolean localAddress(String address) {
        if (!address.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}:[1-9][0-9]{0,4}")) return false;
        String[] fields = address.split("[.:]");
        int first = Integer.parseInt(fields[0]);
        int second = Integer.parseInt(fields[1]);
        int port = Integer.parseInt(fields[4]);
        boolean privateIP = first == 10 || (first == 192 && second == 168) || (first == 172 && second >= 16 && second <= 31);
        return privateIP && second <= 255 && Integer.parseInt(fields[2]) <= 255 && Integer.parseInt(fields[3]) <= 255
                && port >= 1024 && port <= 65535;
    }

    private static boolean allowed(String method, String endpoint) {
        switch (endpoint) {
            case "join": return "POST".equals(method);
            case "pair": return "DELETE".equals(method);
            case "outbox": return "GET".equals(method);
            case "inbox": return "GET".equals(method) || "POST".equals(method) || "DELETE".equals(method);
            default: return false;
        }
    }

    private static boolean binary(String type) {
        return "image/jpeg".equals(type) || "application/pdf".equals(type);
    }

    private static String header(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return "";
    }

    private static void copyHeader(HttpURLConnection relay, Map<String, String> target, String name) {
        String value = relay.getHeaderField(name);
        if (value != null) target.put(name, value);
    }

    static WebResourceResponse message(int code, String text) {
        return new WebResourceResponse("text/plain", "UTF-8", code, "Iris",
                Collections.singletonMap("Cache-Control", "no-store"),
                new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }
}
