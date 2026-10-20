//! Inline `#tag` extraction. Hand-rolled rather than pulling in `regex` —
//! matches the house preference (see Rclip's memchr-based search) for a scan
//! this simple not to need a dependency, and stays Unicode-aware so
//! `#仕事`-style tags work.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TagCount {
    pub tag: String,
    /// Number of notes carrying the tag (each note counts once).
    pub count: usize,
}

/// Every tag across `notes` with how many notes use it — most used first,
/// ties by name. Feeds the search screen's tag browser and the compose
/// box's `#` completion.
pub fn counts(notes: &[super::Note]) -> Vec<TagCount> {
    let mut map = std::collections::HashMap::<&str, usize>::new();
    for note in notes {
        for tag in &note.tags {
            *map.entry(tag.as_str()).or_default() += 1;
        }
    }
    let mut out: Vec<TagCount> = map
        .into_iter()
        .map(|(tag, count)| TagCount { tag: tag.to_string(), count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    out
}

/// Tags in first-appearance order, deduplicated, without the leading `#`.
/// Nothing inside code or a URL counts (see `code_mask`).
pub fn extract(body: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let chars: Vec<char> = body.chars().collect();
    let mask = tag_mask(&chars);
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && !mask[i] && (i == 0 || !is_tag_char(chars[i - 1])) {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_tag_char(chars[end]) {
                end += 1;
            }
            if end > start {
                let tag: String = chars[start..end].iter().collect();
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    tags
}

/// `body` with every `#from` tag (whole tag only, by the same rule as
/// `extract`) rewritten to `#to`, or `None` if it had none. `#from-x` or
/// `a#from` are left alone — they aren't the tag `from`.
pub fn rename_in_body(body: &str, from: &str, to: &str) -> Option<String> {
    let chars: Vec<char> = body.chars().collect();
    let mask = tag_mask(&chars);
    let from_chars: Vec<char> = from.chars().collect();
    let mut out = String::with_capacity(body.len());
    let mut changed = false;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && !mask[i] && (i == 0 || !is_tag_char(chars[i - 1])) {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_tag_char(chars[end]) {
                end += 1;
            }
            if chars[start..end] == from_chars[..] {
                out.push('#');
                out.push_str(to);
                changed = true;
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    changed.then_some(out)
}

/// Whether `name` is usable as a tag as-is: non-empty, tag characters only.
pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(is_tag_char)
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// One flag per char of `chars`: true where the text is code or a URL —
/// fenced code blocks (fence lines included), `inline code` spans, a link's
/// `(destination)`, and bare `http(s)://` URLs. A `#` in there is not a tag
/// (`#include`, `https://x/#anchor`). Mirrors `codeMask` in `src/markdown.ts`
/// so the editor colours exactly the tags saved here.
pub(crate) fn code_mask(chars: &[char]) -> Vec<bool> {
    let mut mask = vec![false; chars.len()];
    let mut fence: Option<(char, usize)> = None;
    // Consecutive non-blank lines outside fences: inline code may span lines
    // within one, but never past a blank line or a fence.
    let mut chunk_start: Option<usize> = None;

    let mut line_start = 0;
    loop {
        let line_end = chars[line_start..]
            .iter()
            .position(|&c| c == '\n')
            .map_or(chars.len(), |p| line_start + p);
        let line = &chars[line_start..line_end];

        if let Some((ch, len)) = fence {
            mask[line_start..line_end].fill(true);
            if let Some((c, n, rest)) = fence_marker(line) {
                if c == ch && n >= len && rest.iter().all(|c| *c == ' ' || *c == '\t') {
                    fence = None;
                }
            }
        } else if let Some((c, n, _)) =
            fence_marker(line).filter(|(c, _, rest)| *c != '`' || !rest.contains(&'`'))
        {
            if let Some(start) = chunk_start.take() {
                mask_inline(chars, start, line_start, &mut mask);
            }
            fence = Some((c, n));
            mask[line_start..line_end].fill(true);
        } else if line.iter().all(|c| c.is_whitespace()) {
            if let Some(start) = chunk_start.take() {
                mask_inline(chars, start, line_start, &mut mask);
            }
        } else if chunk_start.is_none() {
            chunk_start = Some(line_start);
        }

        if line_end == chars.len() {
            break;
        }
        line_start = line_end + 1;
    }
    if let Some(start) = chunk_start {
        mask_inline(chars, start, chars.len(), &mut mask);
    }
    mask
}

/// Where a `#` is not a tag: `code_mask`, plus the inside of every
/// `[[note link]]` — linking to a note titled "#仕事 メモ" doesn't tag this
/// note #仕事. Mirrors `findTags` in `src/markdown.ts`.
fn tag_mask(chars: &[char]) -> Vec<bool> {
    let mut mask = code_mask(chars);
    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i] == '[' && chars[i + 1] == '[' && !mask[i] {
            let start = i + 2;
            let mut j = start;
            while j < chars.len() && !matches!(chars[j], '[' | ']' | '\n') {
                j += 1;
            }
            let closed = j + 1 < chars.len() && chars[j] == ']' && chars[j + 1] == ']';
            if closed && chars[start..j].iter().any(|c| !c.is_whitespace()) {
                mask[i..j + 2].fill(true);
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    mask
}

/// A ``` / ~~~ fence at the start of `line` (up to 3 spaces of indent): its
/// char, run length, and what follows the run.
fn fence_marker(line: &[char]) -> Option<(char, usize, &[char])> {
    let indent = line.iter().take_while(|c| **c == ' ').count();
    if indent > 3 {
        return None;
    }
    let ch = *line.get(indent)?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let n = line[indent..].iter().take_while(|c| **c == ch).count();
    (n >= 3).then(|| (ch, n, &line[indent + n..]))
}

fn mask_inline(chars: &[char], from: usize, to: usize, mask: &mut [bool]) {
    let run = |at: usize| chars[at..to].iter().take_while(|c| **c == '`').count();
    let mut i = from;
    while i < to {
        let c = chars[i];
        if c == '`' {
            // Look for a closing run of exactly the same length.
            let n = run(i);
            let mut j = i + n;
            let mut close = None;
            while j < to {
                if chars[j] == '`' {
                    let k = run(j);
                    if k == n {
                        close = Some(j);
                        break;
                    }
                    j += k;
                } else {
                    j += 1;
                }
            }
            match close {
                Some(close) => {
                    mask[i..close + n].fill(true);
                    i = close + n;
                }
                None => i += n,
            }
            continue;
        }
        if c == ']' && chars.get(i + 1) == Some(&'(') {
            let close = chars[i + 2..]
                .iter()
                .position(|&c| c == ')' || c == '\n')
                .map(|p| i + 2 + p)
                .filter(|&p| chars[p] == ')');
            if let Some(close) = close {
                mask[i + 1..=close].fill(true);
                i = close + 1;
                continue;
            }
        }
        if (c == 'h' || c == 'H')
            && (i == from || !is_tag_char(chars[i - 1]))
            && starts_url(&chars[i..])
        {
            let mut j = i;
            while j < to && !chars[j].is_whitespace() {
                j += 1;
            }
            mask[i..j].fill(true);
            i = j;
            continue;
        }
        i += 1;
    }
}

fn starts_url(s: &[char]) -> bool {
    let head = s.iter().take(8).collect::<String>().to_ascii_lowercase();
    head.starts_with("http://") || head.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_ascii_and_unicode_tags() {
        assert_eq!(extract("todo #work and #仕事 stuff"), vec!["work", "仕事"]);
    }

    #[test]
    fn dedups_and_ignores_a_bare_hash() {
        assert_eq!(extract("# not a tag, #dup #dup"), vec!["dup"]);
    }

    #[test]
    fn renames_whole_tags_only() {
        let body = "#rust と #rust-lang、a#rust、#rust
#Rust";
        assert_eq!(
            rename_in_body(body, "rust", "Rust").as_deref(),
            Some("#Rust と #rust-lang、a#rust、#Rust
#Rust")
        );
        assert_eq!(rename_in_body("no tags here", "rust", "x"), None);
    }

    #[test]
    fn code_and_urls_are_not_tags() {
        let body = "#real\n```c\n#include <x>\n```\n`#inline` and [l](https://x.com/#anchor) https://y.jp/#frag #after";
        assert_eq!(extract(body), vec!["real", "after"]);
        // Headings are not tags; a `#tag` after a heading's text is.
        assert_eq!(extract("## 見出し #tag"), vec!["tag"]);
        // An unclosed fence runs to the end of the note.
        assert_eq!(extract("~~~\n#nope"), Vec::<String>::new());
        // Renaming leaves code alone.
        assert_eq!(rename_in_body("#a `#a`", "a", "b").as_deref(), Some("#b `#a`"));
    }

    /// The cases in `fixtures/markdown-parity.json` are also run against the
    /// frontend's copy of these rules (`src/markdown.test.ts`), so the editor
    /// can't drift from what the backend saves.
    #[test]
    fn matches_the_shared_parity_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/markdown-parity.json")).unwrap();
        for case in fixture["tags"].as_array().unwrap() {
            let body = case["body"].as_str().unwrap();
            let want: Vec<String> = serde_json::from_value(case["tags"].clone()).unwrap();
            assert_eq!(extract(body), want, "tags of {body:?}");
        }
        for case in fixture["charCount"].as_array().unwrap() {
            let body = case["body"].as_str().unwrap();
            assert_eq!(super::super::char_count(body) as u64, case["count"].as_u64().unwrap(), "{body:?}");
        }
    }

    #[test]
    fn ignores_a_hash_inside_a_word() {
        assert_eq!(extract("a#b #real"), vec!["real"]);
    }
}
