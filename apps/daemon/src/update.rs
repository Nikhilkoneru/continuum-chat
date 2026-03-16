use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Context;
use semver::Version;
use serde::Deserialize;

use crate::config::Config;
use crate::{runtime, service};

const RELEASE_OWNER: &str = "Nikhilkoneru";
const RELEASE_REPO: &str = "github-personal-assistant";
const BINARY_NAME: &str = "gcpa";

#[derive(Debug, Clone)]
pub struct UpdateOptions {
    pub version: Option<String>,
    pub check: bool,
    pub force: bool,
    pub restart_service: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

pub async fn run(config: &Config, options: UpdateOptions) -> anyhow::Result<()> {
    let current_version =
        Version::parse(runtime::app_version()).context("Current gcpa version is invalid")?;
    let release = match fetch_release(options.version.as_deref()).await? {
        Some(release) => release,
        None if options.check => {
            println!(
                "No published gcpa releases were found yet for {}/{}.",
                RELEASE_OWNER, RELEASE_REPO
            );
            return Ok(());
        }
        None => {
            anyhow::bail!(
                "No published gcpa releases were found yet for {}/{}.",
                RELEASE_OWNER,
                RELEASE_REPO
            );
        }
    };
    let target_version = parse_release_version(&release.tag_name)?;

    if options.check {
        if !options.force && target_version <= current_version {
            println!("gcpa {} is up to date.", current_version);
        } else {
            println!(
                "Update available for {} (target {}, current {}).",
                release.tag_name,
                runtime::build_target(),
                current_version
            );
            println!(
                "Run `{}` to install it.",
                recommended_update_command(config)
            );
            println!("Release: {}", release.html_url);
        }
        return Ok(());
    }

    if !options.force && target_version <= current_version {
        println!("gcpa {} is already up to date.", current_version);
        return Ok(());
    }

    let asset_name = release_asset_name(runtime::build_target());
    let asset = release
        .assets
        .iter()
        .find(|candidate| candidate.name == asset_name)
        .ok_or_else(|| {
            let available = release
                .assets
                .iter()
                .map(|candidate| candidate.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::anyhow!(
                "Release {} does not contain {}. Available assets: {}",
                release.tag_name,
                asset_name,
                available
            )
        })?;

    let temp_dir = tempfile::tempdir().context("Could not create a temporary update directory")?;
    let archive_path = temp_dir.path().join(&asset.name);
    download_asset(&asset.browser_download_url, &archive_path).await?;
    let extracted_binary = extract_binary(&archive_path, temp_dir.path())?;

    self_replace::self_replace(&extracted_binary)
        .context("Failed to replace the gcpa executable with the downloaded release")?;

    println!(
        "Updated gcpa from {} to {} for target {}.",
        current_version,
        release.tag_name,
        runtime::build_target()
    );
    println!("Release: {}", release.html_url);

    let service_installed = runtime::service_definition_path(config).exists();
    if options.restart_service {
        if service_installed {
            service::restart(config)?;
        } else {
            println!(
                "No auto-start service is installed. Restart any running daemon process manually."
            );
        }
    } else if service_installed {
        println!(
            "Restart the background daemon with `{}` to pick up the new binary.",
            format!("{} daemon service restart", runtime::cli_name())
        );
    }

    Ok(())
}

async fn fetch_release(version: Option<&str>) -> anyhow::Result<Option<GitHubRelease>> {
    let endpoint = match version {
        Some(value) => format!(
            "https://api.github.com/repos/{}/{}/releases/tags/{}",
            RELEASE_OWNER,
            RELEASE_REPO,
            normalize_tag(value)
        ),
        None => format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            RELEASE_OWNER, RELEASE_REPO
        ),
    };

    let response = reqwest::Client::builder()
        .user_agent(format!(
            "{}/{}",
            runtime::cli_name(),
            runtime::app_version()
        ))
        .build()?
        .get(&endpoint)
        .send()
        .await
        .with_context(|| format!("Failed to fetch release metadata from {endpoint}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let response = response
        .error_for_status()
        .with_context(|| format!("GitHub release lookup failed for {endpoint}"))?;

    response
        .json::<GitHubRelease>()
        .await
        .context("Failed to decode the GitHub release response")
        .map(Some)
}

async fn download_asset(url: &str, destination: &Path) -> anyhow::Result<()> {
    let response = reqwest::Client::builder()
        .user_agent(format!(
            "{}/{}",
            runtime::cli_name(),
            runtime::app_version()
        ))
        .build()?
        .get(url)
        .send()
        .await
        .with_context(|| format!("Failed to download update asset from {url}"))?;

    let bytes = response
        .error_for_status()
        .with_context(|| format!("GitHub returned an error while downloading {url}"))?
        .bytes()
        .await
        .with_context(|| format!("Failed to read the downloaded asset body from {url}"))?;

    fs::write(destination, &bytes)
        .with_context(|| format!("Failed to write {}", destination.display()))?;
    Ok(())
}

fn extract_binary(archive_path: &Path, destination_dir: &Path) -> anyhow::Result<PathBuf> {
    let target_binary = binary_name_for_target(runtime::build_target());
    let destination = destination_dir.join(target_binary);

    if archive_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        let file = File::open(archive_path)
            .with_context(|| format!("Failed to open {}", archive_path.display()))?;
        let mut archive = zip::ZipArchive::new(file)
            .with_context(|| format!("Failed to read {}", archive_path.display()))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let name = Path::new(entry.name());
            if name.file_name().and_then(|value| value.to_str()) == Some(target_binary) {
                let mut output = File::create(&destination)
                    .with_context(|| format!("Failed to create {}", destination.display()))?;
                io::copy(&mut entry, &mut output)
                    .with_context(|| format!("Failed to extract {}", destination.display()))?;
                ensure_executable(&destination)?;
                return Ok(destination);
            }
        }
    } else {
        let archive = File::open(archive_path)
            .with_context(|| format!("Failed to open {}", archive_path.display()))?;
        let decoder = flate2::read::GzDecoder::new(archive);
        let mut archive = tar::Archive::new(decoder);
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?;
            if path.file_name().and_then(|value| value.to_str()) == Some(target_binary) {
                entry.unpack(&destination).with_context(|| {
                    format!(
                        "Failed to extract {} from {}",
                        target_binary,
                        archive_path.display()
                    )
                })?;
                ensure_executable(&destination)?;
                return Ok(destination);
            }
        }
    }

    anyhow::bail!("The downloaded archive did not contain {}.", target_binary)
}

fn ensure_executable(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }

    Ok(())
}

fn normalize_tag(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.starts_with('v') {
        trimmed.to_string()
    } else {
        format!("v{trimmed}")
    }
}

fn parse_release_version(tag: &str) -> anyhow::Result<Version> {
    Version::parse(tag.trim_start_matches('v'))
        .with_context(|| format!("Release tag {tag} is not a valid semantic version"))
}

fn release_asset_name(target: &str) -> String {
    if target.contains("windows") {
        format!("{BINARY_NAME}-{target}.zip")
    } else {
        format!("{BINARY_NAME}-{target}.tar.gz")
    }
}

fn binary_name_for_target(target: &str) -> &'static str {
    if target.contains("windows") {
        "gcpa.exe"
    } else {
        "gcpa"
    }
}

fn recommended_update_command(config: &Config) -> String {
    if runtime::service_definition_path(config).exists() {
        format!("{} update --restart-service", runtime::cli_name())
    } else {
        format!("{} update", runtime::cli_name())
    }
}
