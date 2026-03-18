use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::preferences_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/copilot/preferences",
            get(get_preferences).put(set_preferences),
        )
        .route("/api/copilot/status", get(get_status))
        .route("/api/copilot/sessions/:session_id", delete(delete_session))
}

async fn get_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;
    let prefs = preferences_store::get_preferences(&state.db, &state.config).await?;
    Ok(Json(json!({ "preferences": prefs })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPreferences {
    #[serde(default)]
    approval_mode: Option<String>,
    #[serde(default)]
    general_chat_workspace_path: Option<Option<String>>,
}

async fn set_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SetPreferences>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;
    let approval_mode = body.approval_mode.as_deref().map(|mode| match mode {
        "safer-defaults" => "safer-defaults",
        _ => "approve-all",
    });
    let prefs = preferences_store::set_preferences(
        &state.db,
        &state.config,
        approval_mode,
        body.general_chat_workspace_path.as_ref().map(|value| value.as_deref()),
    )
    .await?;
    Ok(Json(json!({ "preferences": prefs })))
}

async fn get_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;

    let connection = state.copilot.get_or_create_connection().await;
    let connected = matches!(connection, Ok(ref conn) if conn.is_alive().await);
    let status = match &connection {
        Ok(conn) => conn.get_status().await.ok(),
        Err(_) => None,
    };
    let auth = match &connection {
        Ok(conn) => conn.get_auth_status().await.ok(),
        Err(_) => None,
    };
    let sessions = match &connection {
        Ok(conn) => conn.list_sessions().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let last_session_id = match &connection {
        Ok(conn) => conn.get_last_session_id().await.ok().flatten(),
        Err(_) => None,
    };

    Ok(Json(json!({
        "status": {
            "version": status.as_ref().map(|value| value.version.clone()).unwrap_or_else(|| crate::runtime::app_version().to_string()),
            "protocolVersion": status.as_ref().map(|value| value.protocol_version).unwrap_or(2),
            "connectionState": if connected { "connected" } else { "disconnected" },
        },
        "auth": {
            "isAuthenticated": auth.as_ref().map(|value| value.is_authenticated).unwrap_or_else(|| state.config.is_copilot_configured()),
            "authType": auth.as_ref().and_then(|value| value.auth_type.clone()).unwrap_or_else(|| state.config.copilot_auth_mode().to_string()),
            "host": auth.as_ref().and_then(|value| value.host.clone()),
            "login": auth.as_ref().and_then(|value| value.login.clone()),
            "statusMessage": auth.as_ref().and_then(|value| value.status_message.clone()),
        },
        "sessions": sessions,
        "lastSessionId": last_session_id,
    })))
}

async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Result<axum::http::StatusCode, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;
    let conn = state
        .copilot
        .get_or_create_connection()
        .await
        .map_err(|error| AppError::Internal(format!("Copilot connection failed: {error}")))?;
    conn.delete_session(&session_id)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to delete Copilot session: {error}")))?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
