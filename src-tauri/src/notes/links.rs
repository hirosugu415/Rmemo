//! `[[title]]` links between notes. A link resolves by the target's display
//! title (case-insensitive), so renaming a note's title would orphan every
//! link to it — `rename_in_body` is what follows the rename.

use super::tags::code_mask;

/// `body` with every `[[from]]` (case-insensitive, surrounding spaces
/// ignored, outside code) rewritten to `[[to]]`, or `None` if it has none.
pub fn rename_in_body(body: &str, from: &str, to: &str) -> Option<String> {
    let from = from.trim().to_lowercase();
    if from.is_empty() {
        return None;
    }
    let chars: Vec<char> = body.chars().collect();
    let mask = code_mask(&chars);
    let mut out = String::with_capacity(body.len());
    let mut changed = false;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' && chars.get(i + 1) == Some(&'[') && !mask[i] {
            let inner_start = i + 2;
            let close = chars[inner_start..]
                .windows(2)
                .position(|w| w == [']', ']'])
                .map(|p| inner_start + p)
                .filter(|&c| !chars[inner_start..c].iter().any(|&ch| matches!(ch, '\n' | '[' | ']')));
            if let Some(close) = close {
                let inner: String = chars[inner_start..close].iter().collect();
                if inner.trim().to_lowercase() == from {
                    out.push_str("[[");
                    out.push_str(to.trim());
                    out.push_str("]]");
                    changed = true;
                    i = close + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_matching_links_only() {
        let body = "[[買い物メモ]] と [[ 買い物メモ ]] と [[買い物メモ2]]\n`[[買い物メモ]]`";
        assert_eq!(
            rename_in_body(body, "買い物メモ", "買い物リスト").as_deref(),
            Some("[[買い物リスト]] と [[買い物リスト]] と [[買い物メモ2]]\n`[[買い物メモ]]`")
        );
        assert_eq!(rename_in_body("[[Rust]]", "rust", "Rust 入門").as_deref(), Some("[[Rust 入門]]"));
        assert_eq!(rename_in_body("リンクなし", "a", "b"), None);
    }
}
