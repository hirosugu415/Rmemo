//! Bulk import of old `.txt` notes: pick a folder, and every `.txt` under it
//! (recursively) becomes a Keep note — or pick the `.txt` files themselves. The text is carried over as-is — plain
//! text already reads fine in the editor, which shows source lines verbatim —
//! with only the information that would otherwise be lost folded in:
//!
//! - the filename, as a `# 見出し` first line when the first line isn't
//!   already a short title starting with it (Rmemo titles a note by its
//!   first line, not its name);
//! - the folders it sat in (the picked one included; for a picked file, the
//!   folder it's in) and `#取り込み`, as
//!   tags on the last line — each optional, see `ImportOptions`;
//! - its dates, copied onto the new file so the note lists where it belongs
//!   in time instead of all landing on top as "today".
//!
//! The one edit to the text itself: `##見出し` at a line start gets its
//! missing space, since without it `#見出し` would read as a tag.
//!
//! Encoding is sniffed per file (BOM → UTF-8 → Shift_JIS), since a folder of
//! old notes is usually a mix of Notepad's past defaults.

use super::{store, tags};
use crate::config::{Settings, Status};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Notepad's names for a file nobody named — not worth a heading.
const DEFAULT_NAMES: &[&str] = &["新規テキスト ドキュメント", "new text document", "無題", "untitled"];
/// A first line longer than this is a paragraph, not a title — it gets the
/// filename as a heading even when it starts with it (`夢を見ました。始業式か…`).
const TITLE_MAX: usize = 40;
/// Put on every imported note with `ImportOptions::import_tag`, so a batch
/// can be found and reviewed later.
pub const IMPORT_TAG: &str = "取り込み";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub folder_tags: bool,
    pub import_tag: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// The picked folder; `None` when files were picked.
    pub dir: Option<String>,
    /// What will be imported — handed back as-is to `import`, so it is
    /// exactly what the confirmation counted.
    pub files: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    /// The new notes, in import order — the 整形 review walks these.
    pub files: Vec<ImportedFile>,
    /// Same text as a note that already exists — e.g. the folder was
    /// imported before.
    pub duplicates: usize,
    pub empty: usize,
    /// Read as Shift_JIS but with undecodable bytes; imported anyway.
    pub garbled: Vec<String>,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub filename: String,
    /// The `.txt` as it read (decoded, line endings as `\n`), so the review
    /// can show every change the import made, not only the 整形.
    pub original: String,
}

/// Every `.txt` under `root`, sorted by path. Symlinks are not followed (no
/// loops), and anything inside `notes_dir` is left out so picking a parent
/// of the notes folder can't import Rmemo's own files.
pub fn collect(root: &Path, notes_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if dir.starts_with(notes_dir) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() && is_txt(&path) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn is_txt(path: &Path) -> bool {
    path.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("txt"))
}

/// `files` (or, with `dir`, every `.txt` under it) as an `ImportPreview`.
pub fn preview(dir: Option<&Path>, files: Vec<PathBuf>, notes_dir: &Path) -> ImportPreview {
    let files = match dir {
        Some(root) => collect(root, notes_dir),
        None => files,
    };
    let bytes = files.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
    ImportPreview {
        dir: dir.map(|d| d.to_string_lossy().into_owned()),
        files: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        bytes,
    }
}

/// Text of a `.txt` file and whether decoding had to replace bytes.
pub fn decode(bytes: &[u8]) -> (String, bool) {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, lossy) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return (text.into_owned(), lossy);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), false);
    }
    // encoding_rs's SHIFT_JIS is the WHATWG one, i.e. Windows' CP932.
    let (text, _, lossy) = encoding_rs::SHIFT_JIS.decode(bytes);
    (text.into_owned(), lossy)
}

/// The note body for a `.txt` whose name (without `.txt`) is `stem`, ending
/// in a line of `tags` (raw names — folder names are made tag-safe here).
/// `None` for a blank file.
pub fn to_markdown(text: &str, stem: &str, tags: &[String]) -> Option<String> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim_end();
    // Leading blank lines go (so an added heading sits right on the text),
    // but the first real line keeps its indentation.
    let skip: usize = text.split('\n').take_while(|l| l.trim().is_empty()).map(|l| l.len() + 1).sum();
    let text = fix_headings(&text[skip.min(text.len())..]);
    if text.trim().is_empty() {
        return None;
    }

    let mut out = String::new();
    if needs_heading(&text, stem) {
        out.push_str(&format!("# {}\n\n", stem.trim()));
    }
    out.push_str(&text);
    let mut names: Vec<String> = Vec::new();
    for t in tags.iter().filter_map(|t| tag_name(t)) {
        if !names.contains(&t) {
            names.push(t);
        }
    }
    if !names.is_empty() {
        out.push_str("\n\n");
        out.push_str(&names.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "));
    }
    out.push('\n');
    Some(out)
}

/// `##見出し` → `## 見出し` at line starts (two to six `#`; a single `#word`
/// stays, it may well be meant as a tag). Lines inside code fences are left.
fn fix_headings(text: &str) -> String {
    let mut in_fence = false;
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let t = line.trim_start();
            if t.starts_with("```") || t.starts_with("~~~") {
                in_fence = !in_fence;
                return line.to_string();
            }
            let hashes = t.chars().take_while(|&c| c == '#').count();
            let rest = &t[hashes..];
            if in_fence || !(2..=6).contains(&hashes) || rest.is_empty() || rest.starts_with(char::is_whitespace) {
                line.to_string()
            } else {
                format!("{} {rest}", &t[..hashes])
            }
        })
        .collect();
    lines.join("\n")
}

/// Whether the filename carries something the first line doesn't: it's not
/// a default name, and the title line isn't simply the name (or a short line
/// starting with it).
fn needs_heading(text: &str, stem: &str) -> bool {
    let stem = stem.trim();
    let lower = stem.to_lowercase();
    if stem.is_empty() || DEFAULT_NAMES.iter().any(|d| lower.starts_with(d)) {
        return false;
    }
    let title = super::title_text(text).unwrap_or_default().to_lowercase();
    !(title.starts_with(&lower) && title.chars().count() <= TITLE_MAX)
}

/// A folder name as a tag: characters a tag can't hold become `_`
/// (`議事録 2019` → `議事録_2019`).
fn tag_name(folder: &str) -> Option<String> {
    let mapped: String = folder.chars().map(|c| if tags::is_valid_name(&c.to_string()) { c } else { '_' }).collect();
    let collapsed = mapped.split('_').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("_");
    tags::is_valid_name(&collapsed).then_some(collapsed)
}

/// What a body compares as for duplicate detection: a last line of nothing
/// but tags is left out, so re-importing with other tag options still
/// recognises a note that's already there.
fn dedupe_key(body: &str) -> String {
    let body = body.replace("\r\n", "\n");
    let body = body.trim();
    let tags_only =
        |l: &str| l.split_whitespace().all(|w| w.strip_prefix('#').is_some_and(tags::is_valid_name));
    match body.rsplit_once('\n') {
        Some((rest, last)) if tags_only(last) => rest.trim().to_string(),
        _ => body.to_string(),
    }
}

/// Imports `files` as Keep notes. Folder tags are taken from the path below
/// `dir` (the picked folder, itself included), or for files picked on their
/// own, from the folder each one is in. `existing` is the current notes'
/// bodies, so a re-import skips what's already there.
pub fn import<'a>(
    settings: &Settings,
    dir: Option<&Path>,
    files: &[PathBuf],
    options: ImportOptions,
    existing: impl IntoIterator<Item = &'a str>,
) -> ImportReport {
    let mut seen: HashSet<String> = existing.into_iter().map(dedupe_key).collect();
    let mut report = ImportReport::default();
    for path in files {
        let Some(root) = dir.or_else(|| path.parent()) else { continue };
        let shown = path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned();
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                report.failed.push(format!("{shown}: {e}"));
                continue;
            }
        };
        let (text, lossy) = decode(&bytes);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        let mut tags: Vec<String> = Vec::new();
        if options.folder_tags {
            tags.extend(root.file_name().map(|n| n.to_string_lossy().into_owned()));
            if let Some(rel) = path.parent().and_then(|p| p.strip_prefix(root).ok()) {
                tags.extend(rel.iter().map(|c| c.to_string_lossy().into_owned()));
            }
        }
        if options.import_tag {
            tags.push(IMPORT_TAG.to_string());
        }
        let Some(body) = to_markdown(&text, stem, &tags) else {
            report.empty += 1;
            continue;
        };
        if !seen.insert(dedupe_key(&body)) {
            report.duplicates += 1;
            continue;
        }
        let note = match store::create(settings, &body, Status::Keep) {
            Ok(n) => n,
            Err(e) => {
                report.failed.push(format!("{shown}: {e}"));
                continue;
            }
        };
        let target = super::scan::status_dir(settings, Status::Keep).join(&note.filename);
        if let Err(e) = copy_times(path, &target) {
            eprintln!("[import] could not copy dates onto {target:?}: {e}");
        }
        if lossy {
            report.garbled.push(shown);
        }
        report.imported += 1;
        report.files.push(ImportedFile {
            filename: note.filename,
            original: text.replace("\r\n", "\n").replace('\r', "\n"),
        });
    }
    report
}

/// Gives `to` the dates of `from`. Created is the earlier of the source's
/// created/modified: a copied file's created time is when it was copied, and
/// its modified time is often the truer age.
fn copy_times(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::metadata(from)?;
    let mut times = std::fs::FileTimes::new();
    let modified = meta.modified().ok();
    if let Some(m) = modified {
        times = times.set_modified(m);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTimesExt;
        let created = match (meta.created().ok(), modified) {
            (Some(c), Some(m)) => Some(c.min(m)),
            (c, m) => c.or(m),
        };
        if let Some(c) = created {
            times = times.set_created(c);
        }
    }
    std::fs::OpenOptions::new().write(true).open(to)?.set_times(times)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: ImportOptions = ImportOptions { folder_tags: true, import_tag: true };

    #[test]
    fn encodings_are_sniffed() {
        assert_eq!(decode("あいう".as_bytes()), ("あいう".to_string(), false));
        assert_eq!(decode(b"\xEF\xBB\xBFabc"), ("abc".to_string(), false));
        // "メモ" in Shift_JIS.
        assert_eq!(decode(b"\x83\x81\x83\x82"), ("メモ".to_string(), false));
        // UTF-16LE with BOM: "あ".
        assert_eq!(decode(b"\xFF\xFE\x42\x30"), ("あ".to_string(), false));
    }

    #[test]
    fn filename_becomes_a_heading_only_when_it_adds_something() {
        assert_eq!(to_markdown("牛乳\r\n卵\r\n", "買い物", &[]).unwrap(), "# 買い物\n\n牛乳\n卵\n");
        assert_eq!(to_markdown("買い物リスト\n牛乳", "買い物", &[]).unwrap(), "買い物リスト\n牛乳\n");
        assert_eq!(to_markdown("本文", "新規テキスト ドキュメント (3)", &[]).unwrap(), "本文\n");
        assert_eq!(to_markdown(" \r\n\n", "x", &[]), None);
        // A first line that starts with the name but is a whole paragraph.
        let dream = "夢を見ました。始業式か、授業はじめかわからないけど時代は自分の中学時代ぐらい？校舎はまったく知らない場所";
        assert!(to_markdown(dream, "夢を見ました", &[]).unwrap().starts_with("# 夢を見ました\n\n夢を見ました。"));
        // Leading blank lines don't end up under the heading.
        assert_eq!(
            to_markdown("\n\n  あなたは○○です。\n", "有能プロンプト", &[]).unwrap(),
            "# 有能プロンプト\n\n  あなたは○○です。\n"
        );
    }

    #[test]
    fn a_heading_missing_its_space_is_not_left_as_a_tag() {
        let md = to_markdown("天気通知アプリ\n##インフラ：React\n## つまり\n#タグ\n```\n##x\n```", "天気通知アプリ", &[])
            .unwrap();
        assert_eq!(md, "天気通知アプリ\n## インフラ：React\n## つまり\n#タグ\n```\n##x\n```\n");
        assert!(!tags::extract(&md).contains(&"インフラ".to_string()));
    }

    #[test]
    fn folders_become_tags() {
        let names = vec!["メモ".into(), "仕事".into(), "議事録 2019".into(), "(old)".into(), "仕事".into()];
        assert_eq!(
            to_markdown("会議\n内容", "会議", &names).unwrap(),
            "会議\n内容\n\n#メモ #仕事 #議事録_2019 #old\n"
        );
        assert_eq!(tag_name("!!!"), None);
        assert_eq!(dedupe_key("会議\n内容\n\n#メモ #取り込み\n"), "会議\n内容");
    }

    #[test]
    fn import_walks_subfolders_skips_duplicates_and_keeps_dates() {
        let base = std::env::temp_dir().join("rmemo-import-test");
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("古いメモ");
        std::fs::create_dir_all(src.join("仕事")).unwrap();
        std::fs::write(src.join("a.txt"), "first\nbody").unwrap();
        std::fs::write(src.join("仕事").join("b.TXT"), b"\x83\x81\x83\x82").unwrap();
        std::fs::write(src.join("仕事").join("ignore.md"), "x").unwrap();
        std::fs::write(src.join("empty.txt"), "").unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
        std::fs::File::options()
            .write(true)
            .open(src.join("a.txt"))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();

        let settings = Settings { notes_dir: base.join("notes"), ..Settings::default() };
        let files = collect(&src, &settings.notes_dir);
        let report = import(&settings, Some(&src), &files, ALL, []);
        assert_eq!((report.imported, report.empty, report.duplicates), (2, 1, 0), "{report:?}");
        let names: Vec<&str> = report.files.iter().map(|f| f.filename.as_str()).collect();
        assert_eq!(names, vec!["a.md", "b.md"]);
        assert_eq!(report.files[0].original, "first\nbody");
        let keep = super::super::scan::status_dir(&settings, Status::Keep);
        assert_eq!(std::fs::read_to_string(keep.join("a.md")).unwrap(), "# a\n\nfirst\nbody\n\n#古いメモ #取り込み\n");
        assert_eq!(std::fs::read_to_string(keep.join("b.md")).unwrap(), "# b\n\nメモ\n\n#古いメモ #仕事 #取り込み\n");
        assert_eq!(std::fs::metadata(keep.join("a.md")).unwrap().modified().unwrap(), old);

        // Again, without tags this time: still recognised as already there.
        let bodies: Vec<String> = super::super::scan::scan_all(&settings).into_iter().map(|n| n.body).collect();
        let none = ImportOptions { folder_tags: false, import_tag: false };
        let again = import(&settings, Some(&src), &files, none, bodies.iter().map(String::as_str));
        assert_eq!((again.imported, again.duplicates), (0, 2), "{again:?}");

        // A file picked on its own is tagged with the folder it's in.
        std::fs::write(src.join("仕事").join("c.txt"), "single").unwrap();
        let one = import(&settings, None, &[src.join("仕事").join("c.txt")], ALL, []);
        assert_eq!(one.files[0].filename, "c.md");
        assert_eq!(std::fs::read_to_string(keep.join("c.md")).unwrap(), "# c

single

#仕事 #取り込み
");
    }
}
