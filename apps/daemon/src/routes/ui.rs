use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use include_dir::{include_dir, Dir};

static UI_DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../client/dist");

pub async fn serve(uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let requested = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };

    let asset = UI_DIST
        .get_file(requested)
        .map(|file| (requested, file))
        .or_else(|| {
            if requested.contains('.') {
                None
            } else {
                UI_DIST
                    .get_file("index.html")
                    .map(|file| ("index.html", file))
            }
        });

    match asset {
        Some((path, file)) => response_for_asset(path, file.contents()),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn response_for_asset(path: &str, contents: &'static [u8]) -> Response {
    let content_type = if path.ends_with(".webmanifest") {
        "application/manifest+json; charset=utf-8".to_string()
    } else {
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string()
    };

    let cache_control = if path == "service-worker.js" {
        "no-cache, no-store, must-revalidate"
    } else if path.ends_with(".html") {
        "no-cache"
    } else {
        "public, max-age=3600"
    };

    let mut response = Response::new(Body::from(contents.to_vec()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_str(cache_control)
            .unwrap_or_else(|_| HeaderValue::from_static("no-cache")),
    );
    response
}
