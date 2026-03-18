use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/models", get(list_models))
}

async fn list_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;

    if let Ok(conn) = state.copilot.get_or_create_connection().await {
        if let Ok(models) = conn.list_models().await {
            let models: Vec<serde_json::Value> = models
                .into_iter()
                .map(|model| {
                    json!({
                        "id": model.id,
                        "name": model.name,
                        "source": "sdk",
                        "supportsReasoning": model.capabilities.supports.reasoning_effort,
                        "capabilities": model.capabilities,
                        "policy": model.policy,
                        "billing": model.billing,
                        "supportedReasoningEfforts": model.supported_reasoning_efforts,
                        "defaultReasoningEffort": model.default_reasoning_effort,
                    })
                })
                .collect();
            return Ok(Json(json!({ "models": models })));
        }
    }

    // Fallback static models
    let models = vec![
        model_entry("gpt-5-mini", "GPT-5 mini", false),
        model_entry("gpt-4.1", "GPT-4.1", false),
        model_entry("claude-sonnet-4", "Claude Sonnet 4", false),
    ];

    Ok(Json(json!({ "models": models })))
}

fn model_entry(id: &str, name: &str, supports_reasoning: bool) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "source": "static",
        "supportsReasoning": supports_reasoning,
    })
}
