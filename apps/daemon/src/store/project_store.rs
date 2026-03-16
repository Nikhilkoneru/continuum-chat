use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::Serialize;
use uuid::Uuid;

use crate::db::entities::projects;
use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub updated_at: String,
}

pub async fn create_project(
    db: &Database,
    owner_id: &str,
    name: &str,
    description: &str,
) -> anyhow::Result<ProjectSummary> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();

    projects::ActiveModel {
        id: Set(id.clone()),
        github_user_id: Set(owner_id.to_string()),
        name: Set(name.to_string()),
        description: Set(description.to_string()),
        created_at: Set(now.clone()),
        updated_at: Set(now.clone()),
    }
    .insert(db.connection())
    .await?;

    Ok(ProjectSummary {
        id,
        name: name.to_string(),
        description: description.to_string(),
        updated_at: now,
    })
}

pub async fn list_projects(db: &Database, owner_id: &str) -> anyhow::Result<Vec<ProjectSummary>> {
    let projects = projects::Entity::find()
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .order_by_desc(projects::Column::UpdatedAt)
        .all(db.connection())
        .await?;

    Ok(projects
        .into_iter()
        .map(|project| ProjectSummary {
            id: project.id,
            name: project.name,
            description: project.description,
            updated_at: project.updated_at,
        })
        .collect())
}

pub async fn get_project(
    db: &Database,
    owner_id: &str,
    project_id: &str,
) -> anyhow::Result<Option<ProjectSummary>> {
    let project = projects::Entity::find_by_id(project_id.to_string())
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?;

    Ok(project.map(|project| ProjectSummary {
        id: project.id,
        name: project.name,
        description: project.description,
        updated_at: project.updated_at,
    }))
}
