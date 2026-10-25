//! Pure in-memory filtering over the note cache — no disk IO, so it is cheap
//! enough to run on every keystroke with no debounce needed on this side.

use super::ocr::{self, OcrText};
use super::{kana, Note, NoteSummary};
use crate::config::Status;
use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Filter {
    pub status: Option<Status>,
    pub query: Option<String>,
}

/// Each search term as the folded strings it may match (see `kana::needles`).
/// Whitespace separates terms, all of which must match (AND) — so
/// `会議 #仕事` finds notes containing both, not only that exact phrase.
pub fn terms(query: &str) -> Vec<Vec<String>> {
    query.split_whitespace().map(kana::needles).collect()
}

/// `ocr` is the text read out of pasted images (see `notes::ocr`): a note
/// also matches on the text of the images it shows.
pub fn apply(notes: &[Note], filter: &Filter, ocr: &OcrText) -> Vec<NoteSummary> {
    let terms = terms(filter.query.as_deref().unwrap_or(""));
    let all_needles: Vec<String> = terms.iter().flatten().cloned().collect();

    notes
        .iter()
        .filter(|n| filter.status.is_none_or(|s| s == n.status))
        .filter_map(|n| {
            if terms.is_empty() {
                return Some(with_image_snippet(n.summary(), n, ocr));
            }
            // Folded once per note, so リンゴ / りんご / ringo all meet.
            let title = kana::fold_str(&n.title);
            let body = kana::fold_str(&n.body);
            let tags: Vec<String> = n.tags.iter().map(|t| kana::fold_str(t)).collect();
            let image_text = ocr::text_for(&n.body, ocr);
            let images = kana::fold_str(&image_text);
            let matches = terms.iter().all(|needles| {
                needles.iter().any(|q| {
                    // A `#仕事` term already matches the bare `仕事` — in the
                    // text and in tags (stored without `#`).
                    title.contains(q.as_str())
                        || body.contains(q.as_str())
                        || tags.iter().any(|t| t.contains(q.as_str()))
                        || images.contains(q.as_str())
                })
            });
            if !matches {
                return None;
            }
            let mut summary = n.summary();
            if let Some(snippet) = super::snippet_around(&n.body, &all_needles) {
                summary.snippet = snippet;
            } else if let Some(snippet) = super::snippet_in(&image_text, &all_needles) {
                // Found only in a picture: say so, and show where.
                summary.snippet = snippet;
                summary.from_image = true;
            }
            Some(with_image_snippet(summary, n, ocr))
        })
        .collect()
}

/// Characters of image text shown for a note that has nothing else.
const IMAGE_SNIPPET: usize = 120;

/// A note that is only images has no text for a snippet — the list showed
/// "(空)". Show what's in the pictures instead: the text read out of them,
/// or just that there are pictures.
fn with_image_snippet(mut summary: NoteSummary, note: &Note, ocr: &OcrText) -> NoteSummary {
    if !summary.snippet.is_empty() {
        return summary;
    }
    let count = super::images::referenced(&note.body).len();
    if count == 0 {
        return summary;
    }
    let text = ocr::text_for(&note.body, ocr).split_whitespace().collect::<Vec<_>>().join(" ");
    summary.snippet = if text.is_empty() {
        // The 画像 label alone says it; a count only when there's more.
        if count == 1 { String::new() } else { format!("{count} 枚") }
    } else if text.chars().count() > IMAGE_SNIPPET {
        format!("{}…", text.chars().take(IMAGE_SNIPPET).collect::<String>())
    } else {
        text
    };
    summary.from_image = true;
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(body: &str) -> Note {
        Note {
            filename: body.into(),
            status: Status::Keep,
            title: body.lines().next().unwrap_or("").into(),
            body: body.into(),
            tags: crate::notes::tags::extract(body),
            created_at: String::new(),
            modified_at: String::new(),
            is_expiring: false,
            char_count: 0,
        }
    }

    #[test]
    fn every_term_must_match() {
        let notes = vec![note("会議メモ #仕事"), note("会議の議事録"), note("買い物 #仕事")];
        let filter = Filter { status: None, query: Some("会議  #仕事".into()) };
        let hits: Vec<_> = apply(&notes, &filter, &OcrText::new()).into_iter().map(|n| n.filename).collect();
        assert_eq!(hits, vec!["会議メモ #仕事"]);
    }

    #[test]
    fn kana_and_romaji_find_the_same_note() {
        let notes = vec![note("リンゴを買う"), note("みかん")];
        for q in ["りんご", "リンゴ", "ringo", "RINGO"] {
            let filter = Filter { status: None, query: Some(q.into()) };
            let hits: Vec<_> = apply(&notes, &filter, &OcrText::new()).into_iter().map(|n| n.filename).collect();
            assert_eq!(hits, vec!["リンゴを買う"], "{q}");
        }
    }

    #[test]
    fn text_in_a_notes_images_finds_it() {
        let notes = vec![note("スクショ\n![](../assets/err.webp)"), note("ほか")];
        let mut ocr = OcrText::new();
        ocr.insert("err.webp".into(), "ファイルが見つかりません".into());
        let filter = Filter { status: None, query: Some("見つかりません".into()) };
        let hits = apply(&notes, &filter, &ocr);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].from_image);
        assert!(hits[0].snippet.contains("見つかりません"), "{}", hits[0].snippet);
    }

    #[test]
    fn a_note_of_only_images_shows_them_instead_of_nothing() {
        let notes = vec![note("![](../assets/a.webp)"), note("![](../assets/b.png)\n![](../assets/c.png)")];
        let mut ocr = OcrText::new();
        ocr.insert("a.webp".into(), "エラーが出た\n画面".into());
        let all = apply(&notes, &Filter::default(), &ocr);
        assert_eq!((all[0].snippet.as_str(), all[0].from_image), ("エラーが出た 画面", true));
        assert_eq!((all[1].snippet.as_str(), all[1].from_image), ("2 枚", true));
    }
}
