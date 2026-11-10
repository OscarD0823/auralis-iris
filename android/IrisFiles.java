package io.github.oscard0823.auralisiris;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;
import java.util.UUID;

public final class IrisFiles extends ContentProvider {
    private static final String AUTHORITY = "io.github.oscard0823.auralisiris.files";
    private static final long KEEP_MILLIS = 24 * 60 * 60 * 1000L;

    private static File root(Context context) {
        return new File(context.getCacheDir(), "iris-files");
    }

    static File create(Context context, String name) throws IOException {
        if (name.length() > 180 || name.matches(".*[\\p{Cntrl}/\\\\].*") || type(name) == null) {
            throw new IOException("Invalid file name");
        }
        File directory = new File(root(context), UUID.randomUUID().toString());
        if (!directory.mkdirs()) throw new IOException("Cannot create staging directory");
        File file = new File(directory, name);
        if (!file.createNewFile()) throw new IOException("Cannot create temporary file");
        return file;
    }

    static String id(File file) {
        return file.getParentFile().getName();
    }

    static File find(Context context, String id) {
        if (id == null || !id.matches("[0-9a-f-]{36}")) return null;
        File[] files = new File(root(context), id).listFiles(File::isFile);
        return files != null && files.length == 1 ? files[0] : null;
    }

    static void discard(File file) {
        if (file != null && file.delete()) file.getParentFile().delete();
    }

    static void clean(Context context) {
        File[] dirs = root(context).listFiles();
        if (dirs == null) return;
        long cutoff = System.currentTimeMillis() - KEEP_MILLIS;
        for (File dir : dirs) {
            File file = find(context, dir.getName());
            if (file != null && file.lastModified() < cutoff) discard(file);
            else if (file == null && dir.lastModified() < cutoff) dir.delete();
        }
    }

    static Uri uri(File file) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath(id(file)).appendPath(file.getName()).build();
    }

    static String type(String name) {
        if (name.endsWith(".jpg")) return "image/jpeg";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".zip")) return "application/zip";
        return null;
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        List<String> path = uri.getPathSegments();
        File file = path.size() == 2 ? find(getContext(), path.get(0)) : null;
        if (file == null || !file.getName().equals(path.get(1))) throw new FileNotFoundException();
        return file;
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.parseMode(mode));
    }

    @Override public String getType(Uri uri) {
        try {
            return type(resolve(uri).getName());
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) {
        String[] fields = columns != null ? columns : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(fields);
        try {
            File file = resolve(uri);
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String field : fields) {
                if (OpenableColumns.DISPLAY_NAME.equals(field)) row.add(file.getName());
                else if (OpenableColumns.SIZE.equals(field)) row.add(file.length());
                else row.add(null);
            }
        } catch (FileNotFoundException ignored) {
            // The temporary file may already have expired.
        }
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
}
