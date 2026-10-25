//! Windows.Media.Ocr with the accuracy work from Rocr (copied from
//! `Rocr/src-tauri/src/ocr.rs` and `pipeline.rs`, minus its worker thread —
//! Rmemo's `ocr` already runs on one).
//!
//! Windows ships a separate, separately-trained OCR model per language and
//! each is weak at the other's script — the Japanese model reads Latin text
//! with the wrong case, `l`/`1`/`I` confusions and dropped punctuation, the
//! English model turns kana into noise. So when both a CJK and a Latin pack
//! are installed, a recognition runs through **both** engines and
//! [`merge_passes`] splices the results back together per word by script:
//! the CJK engine owns the ideographs, the Latin engine owns the ASCII. With
//! only one usable pack it stays a single pass.
//!
//! Before that, the image is prepared: small ones are enlarged (the engine
//! can't read text only a few pixels tall — 件 comes out as イ牛), and a dark
//! page (an editor or terminal screenshot) is inverted to dark-on-light.

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;

/// The languages read, CJK first. Both are used when both are installed.
const LANGS: &[&str] = &["ja", "en"];

/// One recognized line: its text and the union of its word boxes, in the
/// pixel space of the image that was handed in.
#[derive(Debug, Clone)]
pub struct Line {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone)]
pub struct Recognized {
    pub text: String,
    pub lines: Vec<Line>,
    /// BCP-47 tag of the engine that ran (the CJK one, when both did).
    pub language: String,
}

/// The OCR engines, built on first use and kept. Only for the thread that
/// made it (WinRT, MTA).
pub struct Engines {
    cached: Vec<(String, OcrEngine)>,
}

impl Engines {
    /// `None` when Windows has no OCR language at all.
    pub fn new() -> Option<Self> {
        let mut me = Self { cached: Vec::new() };
        let langs: Vec<String> = LANGS.iter().map(|s| s.to_string()).collect();
        engines_for(&langs, &mut me.cached).ok()?;
        Some(me)
    }

    /// Recognize a tightly packed RGBA image: enlarged if small, inverted if
    /// it's a dark page, then read by one or both engines.
    pub fn recognize_rgba(&mut self, rgba: Vec<u8>, width: u32, height: u32) -> Result<Recognized, String> {
        let max_side = OcrEngine::MaxImageDimension().unwrap_or(4096);
        let (rgba, w, h) = fit(rgba, width, height, max_side);
        let mut bgra = rgba;
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        maybe_invert(&mut bgra, w as i32, h as i32);
        let langs: Vec<String> = LANGS.iter().map(|s| s.to_string()).collect();
        recognize(&bgra, w as i32, h as i32, &langs, &mut self.cached)
    }

}

/// Below this, on the longer edge, text is usually too few pixels tall for
/// Windows.Media.Ocr to read reliably. Upscaling with a real filter before
/// OCR is the standard fix and helps every language. (Rocr `pipeline.rs`.)
const OCR_UPSCALE_TARGET: f64 = 1600.0;
/// The usual enlargement. Measured on terminal and code screenshots against
/// Rocr's 2–4× Lanczos3: 1.5× CatmullRom read both best — at 2× and up, or
/// with a sharper filter, thin monospace strokes break apart
/// (`Compiling` → `( 8P111ng`, `profile` → `pro_fiAe`).
const UPSCALE: f64 = 1.5;
/// Only images smaller than this on the long edge (a tiny crop) get more.
const TINY: f64 = 600.0;

/// Sizes the image for the engine: a small one is enlarged (CatmullRom), one
/// past the engine's limit shrunk to fit. Never enlarged past the limit.
fn fit(rgba: Vec<u8>, w: u32, h: u32, max_side: u32) -> (Vec<u8>, u32, u32) {
    let long = w.max(h) as f64;
    if long <= 0.0 {
        return (rgba, w, h);
    }
    let factor = if long > max_side as f64 {
        max_side as f64 / long
    } else if long < OCR_UPSCALE_TARGET {
        let wanted = if long < TINY { (TINY * 2.0 / long).clamp(UPSCALE, 3.0) } else { UPSCALE };
        let f = wanted.min(max_side as f64 / long);
        if f < 1.2 {
            return (rgba, w, h);
        }
        f
    } else {
        return (rgba, w, h);
    };
    let (nw, nh) = (((w as f64 * factor) as u32).max(1), ((h as f64 * factor) as u32).max(1));
    let Some(img) = image::RgbaImage::from_raw(w, h, rgba.clone()) else {
        return (rgba, w, h);
    };
    let filter = if factor > 1.0 {
        image::imageops::FilterType::CatmullRom
    } else {
        image::imageops::FilterType::Triangle
    };
    (image::imageops::resize(&img, nw, nh, filter).into_raw(), nw, nh)
}

/// Windows.Media.Ocr is trained on dark text over a light page and reads the
/// inverse — light text on a dark editor or terminal — markedly worse. When
/// the image's background is clearly dark, flip every RGB channel before OCR.
///
/// The call is decided from a strided luminance sample (a few thousand
/// pixels); only then does the flip walk the buffer. Deliberately
/// conservative: a light or mid-tone page, or a flat dark block with no
/// lighter text on it, is left untouched. (Rocr `pipeline.rs`.)
fn maybe_invert(bgra: &mut [u8], w: i32, h: i32) -> bool {
    let px_count = (w.max(0) as usize) * (h.max(0) as usize);
    if px_count == 0 || bgra.len() < px_count * 4 {
        return false;
    }

    // 64-bucket luminance histogram over a sample of at most ~8k pixels.
    let stride = (px_count / 8192).max(1);
    let mut hist = [0u32; 64];
    let mut samples = 0u32;
    let mut i = 0;
    while i < px_count {
        let p = i * 4;
        let (b, g, r) = (bgra[p] as u32, bgra[p + 1] as u32, bgra[p + 2] as u32);
        let luma = (b * 18 + g * 182 + r * 54) >> 8; // BT.709-ish
        hist[(luma >> 2) as usize] += 1;
        samples += 1;
        i += stride;
    }
    if samples == 0 {
        return false;
    }

    // Median luminance ≈ the background: screen text is mostly page.
    let mut acc = 0u32;
    let mut bg_luma = 0usize;
    for (bucket, &count) in hist.iter().enumerate() {
        acc += count;
        if acc * 2 >= samples {
            bg_luma = bucket * 4 + 2;
            break;
        }
    }

    // Share of the sample that is clearly lighter than the page — the text.
    let bright_lo = ((bg_luma + 40) >> 2).min(63);
    let bright: u32 = hist[bright_lo..].iter().sum();

    // Dark page, with at least ~1% lighter pixels sitting on it.
    if bg_luma > 110 || bright * 100 < samples {
        return false;
    }

    for px in bgra.chunks_exact_mut(4) {
        px[0] = 255 - px[0];
        px[1] = 255 - px[1];
        px[2] = 255 - px[2];
    }
    true
}

fn s(e: windows::core::Error) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// script helpers
// ---------------------------------------------------------------------------

fn is_cjk_char(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F   // CJK symbols & punctuation
        | 0x3040..=0x30FF // hiragana + katakana
        | 0x3400..=0x4DBF // CJK ext A
        | 0x4E00..=0x9FFF // CJK unified
        | 0xF900..=0xFAFF // CJK compatibility ideographs
        | 0xFF00..=0xFFEF // half/fullwidth forms
    )
}

/// A character the Latin engine should be trusted for: ASCII letters/digits
/// plus the common accented-Latin range.
fn is_latin_alnum(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c as u32, 0x00C0..=0x024F)
}

fn has_latin_alnum(s: &str) -> bool {
    s.chars().any(is_latin_alnum)
}

/// Share of non-space characters that are Latin alphanumerics. Used to reject a
/// Latin-engine word that is really the engine hallucinating over an ideograph.
fn latin_ratio(s: &str) -> f64 {
    let mut latin = 0.0;
    let mut total = 0.0;
    for c in s.chars() {
        if c.is_whitespace() {
            continue;
        }
        total += 1.0;
        if is_latin_alnum(c) {
            latin += 1.0;
        }
    }
    if total == 0.0 {
        0.0
    } else {
        latin / total
    }
}

/// A single katakana letter and nothing else — the shape the CJK engine most
/// often lands on when it misreads a lone Latin glyph (`N`→`ル`, `D`→`ロ`,
/// `I`→`エ`). Excludes the prolonged-sound mark and middle dot.
fn is_lone_katakana(s: &str) -> bool {
    let mut it = s.trim().chars();
    match (it.next(), it.next()) {
        (Some(c), None) => matches!(c as u32, 0x30A1..=0x30FA | 0xFF66..=0xFF9D),
        _ => false,
    }
}

/// Does this token end in a katakana letter? A lone `ル` right after one is
/// probably the broken-off tail of a katakana word (`ベクト｜ル`), not a
/// misread letter, so the rescue leaves it alone.
fn ends_with_katakana(s: &str) -> bool {
    s.trim()
        .chars()
        .last()
        .map(|c| matches!(c as u32, 0x30A1..=0x30FA | 0x30FC | 0xFF66..=0xFF9D))
        .unwrap_or(false)
}

/// Whether a BCP-47 tag names a language whose OCR model is the CJK one.
fn is_cjk_lang(tag: &str) -> bool {
    let t = tag.to_ascii_lowercase();
    t.starts_with("ja") || t.starts_with("zh") || t.starts_with("ko") || t.starts_with("yue")
}

/// Overlap, in pixels, of the closed intervals `[a0,a1]` and `[b0,b1]`.
fn span_overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// Windows.Media.Ocr puts a space between *every* glyph for Japanese/Chinese
/// ("フ ァ イ ル"). Drop a space when the characters on both sides of it are
/// CJK — Latin word spacing is left untouched.
fn tidy_cjk(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ' ' {
            let prev = out.chars().last();
            let next = chars.get(i + 1).copied();
            if let (Some(p), Some(n)) = (prev, next) {
                if is_cjk_char(p) && is_cjk_char(n) {
                    i += 1;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// engine construction
// ---------------------------------------------------------------------------

/// Resolve the requested tags to the engines the OS can actually give us,
/// building and caching each the first time it is asked for. Returns them in
/// requested order; falls back to the user-profile engine only if nothing
/// requested is installed.
fn engines_for<'a>(
    langs: &[String],
    cached: &'a mut Vec<(String, OcrEngine)>,
) -> Result<Vec<(String, &'a OcrEngine)>, String> {
    // De-duplicate the requested tags, keeping order.
    let mut wanted: Vec<String> = Vec::new();
    for tag in langs {
        if !wanted.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            wanted.push(tag.clone());
        }
    }

    // Make sure every buildable tag has an engine in the cache.
    for tag in &wanted {
        if cached
            .iter()
            .any(|(t, _)| t.eq_ignore_ascii_case(tag) || t.split('-').next() == Some(tag.as_str()))
        {
            continue;
        }
        let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag.as_str())) else {
            continue;
        };
        if !OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
            continue;
        }
        if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
            let canon = engine
                .RecognizerLanguage()
                .and_then(|l| l.LanguageTag())
                .map(|h| h.to_string())
                .unwrap_or_else(|_| tag.clone());
            cached.push((canon, engine));
        }
    }

    // Which cached engines satisfy this request, in requested order.
    let mut picked: Vec<usize> = Vec::new();
    for tag in &wanted {
        if let Some(i) = cached
            .iter()
            .position(|(t, _)| t.eq_ignore_ascii_case(tag) || t.split('-').next() == Some(tag.as_str()))
        {
            if !picked.contains(&i) {
                picked.push(i);
            }
        }
    }

    if picked.is_empty() {
        // Nothing requested is installed — fall back to the profile engine.
        if !cached.iter().any(|(t, _)| t == "*profile*") {
            let engine = OcrEngine::TryCreateFromUserProfileLanguages()
                .map_err(|e| format!("no OCR language pack available (tried {langs:?}): {}", s(e)))?;
            let canon = engine
                .RecognizerLanguage()
                .and_then(|l| l.LanguageTag())
                .map(|h| h.to_string())
                .unwrap_or_else(|_| "*profile*".into());
            cached.push((canon, engine));
        }
        picked.push(cached.len() - 1);
    }

    Ok(picked
        .into_iter()
        .map(|i| (cached[i].0.clone(), &cached[i].1))
        .collect())
}

// ---------------------------------------------------------------------------
// recognition
// ---------------------------------------------------------------------------

/// One word and its box, in the pixel space of the bitmap handed to the engine.
#[derive(Debug, Clone)]
struct WordBox {
    text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// One engine pass's take on a single line: the raw string plus its words and
/// their bounding union.
struct PassLine {
    words: Vec<WordBox>,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn recognize(
    bgra: &[u8],
    width: i32,
    height: i32,
    langs: &[String],
    cached: &mut Vec<(String, OcrEngine)>,
) -> Result<Recognized, String> {
    if width <= 0 || height <= 0 {
        return Err("image has zero area".into());
    }
    let want = (width as usize) * (height as usize) * 4;
    if bgra.len() < want {
        return Err(format!(
            "buffer too small: {} bytes for {width}x{height}",
            bgra.len()
        ));
    }

    let engines = engines_for(langs, cached)?;

    // Only actually run a second engine when the pair straddles the script
    // divide (one CJK, one Latin) — that is the only case the merge exploits.
    let to_run: Vec<(String, &OcrEngine)> = {
        let cjk = engines.iter().find(|(t, _)| is_cjk_lang(t));
        let latin = engines.iter().find(|(t, _)| !is_cjk_lang(t));
        match (cjk, latin) {
            (Some(c), Some(l)) => vec![(c.0.clone(), c.1), (l.0.clone(), l.1)],
            _ => vec![(engines[0].0.clone(), engines[0].1)],
        }
    };

    let buffer = CryptographicBuffer::CreateFromByteArray(bgra).map_err(s)?;
    let bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width, height)
            .map_err(s)?;

    let single = to_run.len() == 1;
    let mut passes: Vec<(String, Vec<PassLine>)> = Vec::new();
    for (tag, engine) in &to_run {
        match run_pass(engine, &bitmap) {
            Ok(lines) => passes.push((tag.clone(), lines)),
            // A second engine failing is not fatal — fall back to what we have.
            Err(e) if passes.is_empty() && single => return Err(e),
            Err(_) => {}
        }
    }
    if passes.is_empty() {
        return Err("OCR returned no lines".into());
    }

    Ok(merge_passes(passes))
}

/// Run one engine over the bitmap and collect its lines with per-word boxes.
fn run_pass(engine: &OcrEngine, bitmap: &SoftwareBitmap) -> Result<Vec<PassLine>, String> {
    let result = engine.RecognizeAsync(bitmap).map_err(s)?.get().map_err(s)?;
    let ocr_lines = result.Lines().map_err(s)?;
    let mut out = Vec::new();
    for line in &ocr_lines {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        let words_view = line.Words().map_err(s)?;
        let mut words = Vec::new();
        for word in &words_view {
            let r = word.BoundingRect().map_err(s)?;
            let (wx, wy, ww, wh) = (r.X as f64, r.Y as f64, r.Width as f64, r.Height as f64);
            x0 = x0.min(wx);
            y0 = y0.min(wy);
            x1 = x1.max(wx + ww);
            y1 = y1.max(wy + wh);
            words.push(WordBox {
                text: word.Text().map_err(s)?.to_string(),
                x: wx,
                y: wy,
                w: ww,
                h: wh,
            });
        }
        if words.is_empty() {
            continue;
        }
        out.push(PassLine {
            words,
            x0,
            y0,
            x1,
            y1,
        });
    }
    Ok(out)
}

/// Fuse the engine passes. With a CJK pass and a Latin pass, the CJK pass is
/// the skeleton (it segments ideographs well and picks up nearly everything);
/// every skeleton word that carries Latin letters is swapped for the Latin
/// engine's reading of the same spot, and Latin words the CJK engine dropped
/// are slotted back in. Any other combination just uses the first pass.
fn merge_passes(passes: Vec<(String, Vec<PassLine>)>) -> Recognized {
    let cjk = passes.iter().position(|(t, _)| is_cjk_lang(t));
    let latin = passes.iter().position(|(t, _)| !is_cjk_lang(t));
    let (skel_i, latin_i) = match (cjk, latin) {
        (Some(c), Some(l)) if c != l => (c, Some(l)),
        _ => (0, None),
    };

    let language = passes[skel_i].0.clone();
    let latin_words: Vec<WordBox> = latin_i
        .map(|l| {
            passes[l]
                .1
                .iter()
                .flat_map(|pl| pl.words.iter().cloned())
                .collect()
        })
        .unwrap_or_default();
    let mut consumed = vec![false; latin_words.len()];
    // Every word the CJK engine found, anywhere — see `on_skeleton`.
    let skeleton: Vec<WordBox> = passes[skel_i].1.iter().flat_map(|pl| pl.words.iter().cloned()).collect();

    let mut lines: Vec<Line> = Vec::new();
    for pl in &passes[skel_i].1 {
        let text = merge_line(pl, &latin_words, &mut consumed, &skeleton);
        if text.trim().is_empty() {
            continue;
        }
        lines.push(Line {
            text,
            x: pl.x0,
            y: pl.y0,
            w: pl.x1 - pl.x0,
            h: pl.y1 - pl.y0,
        });
    }

    lines.extend(leftover_lines(&latin_words, &consumed, &skeleton));
    lines.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Recognized {
        text,
        lines,
        language,
    }
}

/// Rebuild one skeleton line, replacing Latin-bearing words with the Latin
/// engine's version and inserting Latin words that fell between ideographs.
/// `consumed` is shared across the whole image so no Latin word is used twice.
/// (Rmemo fix:) whether a Latin word sits on a word the CJK engine already
/// read — then it is that word's other reading, never something the CJK
/// engine missed. Adding it as an extra duplicated text: a label and its
/// value on one row (`列車  かがやき 505号` → `列車505`), or every row of a
/// timetable repeated as loose digits. It can still *replace* the word it
/// sits on; it just never goes in on its own.
fn on_skeleton(lw: &WordBox, skeleton: &[WordBox]) -> bool {
    skeleton.iter().any(|sw| {
        let ix = span_overlap(lw.x, lw.x + lw.w, sw.x, sw.x + sw.w);
        let iy = span_overlap(lw.y, lw.y + lw.h, sw.y, sw.y + sw.h);
        ix * iy >= 0.3 * (lw.w * lw.h).min(sw.w * sw.h).max(1.0)
    })
}

fn merge_line(pl: &PassLine, latin_words: &[WordBox], consumed: &mut [bool], skeleton: &[WordBox]) -> String {
    // Latin words sitting on this line's vertical band, left to right.
    let mid = (pl.y0 + pl.y1) * 0.5;
    let tol = ((pl.y1 - pl.y0) * 0.6).max(6.0);
    let mut band: Vec<usize> = (0..latin_words.len())
        .filter(|&i| !consumed[i])
        .filter(|&i| {
            let w = &latin_words[i];
            (w.y + w.h * 0.5 - mid).abs() <= tol
        })
        .collect();
    band.sort_by(|&a, &b| {
        latin_words[a]
            .x
            .partial_cmp(&latin_words[b].x)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Note: the loop below is still walked when `band` is empty — the
    // lone-"ル" → "N" rescue needs no Latin pass and must run single-engine.

    let mut out: Vec<String> = Vec::new();
    let mut bi = 0usize;
    // Spans of the Latin words already written on this line. (Rmemo fix:)
    // the CJK engine often splits what the Latin engine reads as one word
    // (`stack.` + `len()` vs `stack.len()`); the first piece takes the whole
    // Latin word, and the rest must not then be written again.
    let mut placed: Vec<(f64, f64)> = Vec::new();
    let covered = |placed: &[(f64, f64)], l: f64, r: f64| {
        let w = (r - l).max(1.0);
        placed.iter().map(|&(a, b)| span_overlap(l, r, a, b)).sum::<f64>() >= 0.5 * w
    };

    for (idx, pw) in pl.words.iter().enumerate() {
        let (pw_l, pw_r) = (pw.x, pw.x + pw.w);

        // Flush Latin words entirely left of this skeleton word.
        while bi < band.len() {
            let li = band[bi];
            let lw = &latin_words[li];
            if lw.x + lw.w > pw_l + 1.0 {
                break;
            }
            if on_skeleton(lw, skeleton) {
                // Another line's word (or this one's other reading): leave it
                // for that line to use as a replacement.
                bi += 1;
                continue;
            }
            if !consumed[li] && latin_ratio(&lw.text) >= 0.5 {
                out.push(lw.text.clone());
                placed.push((lw.x, lw.x + lw.w));
            }
            consumed[li] = true;
            bi += 1;
        }

        // (Rmemo fix:) only a purely Latin word is swapped. A word mixing
        // kanji/kana with digits (`11月1日`, `505号`) is the CJK engine's to
        // read — the Latin engine turns its kanji into noise (`Ilhla月日`).
        if has_latin_alnum(&pw.text) && !pw.text.chars().any(is_cjk_char) {
            // Swap in the Latin engine's overlapping words.
            let mut repl: Vec<(f64, String)> = Vec::new();
            for &li in &band {
                if consumed[li] {
                    continue;
                }
                let lw = &latin_words[li];
                let ov = span_overlap(pw_l, pw_r, lw.x, lw.x + lw.w);
                if ov >= 0.3 * pw.w.min(lw.w).max(1.0) {
                    consumed[li] = true;
                    // (Rmemo fix:) a Latin reading that also covers kanji/kana
                    // of this line read them as letters (`11月1日` → `Ilhla`):
                    // keep the CJK engine's word instead.
                    let spans_cjk = pl.words.iter().any(|w| {
                        w.text.chars().any(is_cjk_char)
                            && span_overlap(lw.x, lw.x + lw.w, w.x, w.x + w.w) >= 0.3 * w.w.max(1.0)
                    });
                    if spans_cjk {
                        continue;
                    }
                    if latin_ratio(&lw.text) >= 0.5 {
                        repl.push((lw.x, lw.text.clone()));
                        placed.push((lw.x, lw.x + lw.w));
                    }
                }
            }
            if repl.is_empty() {
                // Already written as part of a longer Latin word: skip it.
                if !covered(&placed, pw_l, pw_r) {
                    out.push(pw.text.clone());
                }
            } else {
                repl.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                out.push(
                    repl.into_iter()
                        .map(|(_, t)| t)
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
        } else {
            // Ideograph — normally the CJK engine is right. Exception: a lone
            // katakana that is *not* the tail of a katakana run is very often
            // the CJK engine misreading an isolated Latin letter used as a
            // variable name (the classic being "N" → "ル"). Recover it from
            // the Latin engine when it saw a single ASCII character at that
            // spot, and fall back to "N" for a bare "ル", which never stands
            // alone in real Japanese.
            let prev_katakana = idx
                .checked_sub(1)
                .map(|j| ends_with_katakana(&pl.words[j].text))
                .unwrap_or(false);

            let rescued = if is_lone_katakana(&pw.text) && !prev_katakana {
                let from_en = band.iter().copied().find_map(|li| {
                    if consumed[li] {
                        return None;
                    }
                    let lw = &latin_words[li];
                    let ov = span_overlap(pw_l, pw_r, lw.x, lw.x + lw.w);
                    if ov < 0.4 * pw.w.min(lw.w).max(1.0) {
                        return None;
                    }
                    let letters: String =
                        lw.text.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
                    (letters.chars().count() == 1).then_some((li, letters))
                });
                if let Some((li, letter)) = from_en {
                    consumed[li] = true;
                    Some(letter)
                } else if pw.text.trim() == "ル" {
                    Some("N".to_string())
                } else {
                    None
                }
            } else {
                None
            };

            out.push(rescued.unwrap_or_else(|| pw.text.clone()));

            // Drop any remaining Latin words sitting on this ideograph.
            for &li in &band {
                if consumed[li] {
                    continue;
                }
                let lw = &latin_words[li];
                let ov = span_overlap(pw_l, pw_r, lw.x, lw.x + lw.w);
                if ov >= 0.5 * pw.w.min(lw.w).max(1.0) {
                    consumed[li] = true;
                }
            }
        }
    }

    // Latin words to the right of the last skeleton word.
    for &li in &band {
        if consumed[li] || on_skeleton(&latin_words[li], skeleton) {
            continue;
        }
        consumed[li] = true;
        let lw = &latin_words[li];
        if latin_ratio(&lw.text) >= 0.5 {
            out.push(lw.text.clone());
        }
    }

    tidy_cjk(&out.join(" "))
}

/// Latin words no skeleton line claimed — whole lines the CJK engine missed.
/// Clustered into lines by vertical proximity.
fn leftover_lines(latin_words: &[WordBox], consumed: &[bool], skeleton: &[WordBox]) -> Vec<Line> {
    let mut idx: Vec<usize> = (0..latin_words.len())
        .filter(|&i| !consumed[i] && latin_ratio(&latin_words[i].text) >= 0.5)
        .filter(|&i| !on_skeleton(&latin_words[i], skeleton))
        .collect();
    if idx.is_empty() {
        return Vec::new();
    }
    idx.sort_by(|&a, &b| {
        latin_words[a]
            .y
            .partial_cmp(&latin_words[b].y)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut lines = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_bottom = f64::MIN;
    for &i in &idx {
        let w = &latin_words[i];
        if !cur.is_empty() && w.y > cur_bottom {
            lines.push(assemble_line(latin_words, &cur));
            cur.clear();
            cur_bottom = f64::MIN;
        }
        cur_bottom = cur_bottom.max(w.y + w.h);
        cur.push(i);
    }
    if !cur.is_empty() {
        lines.push(assemble_line(latin_words, &cur));
    }
    lines
}

fn assemble_line(latin_words: &[WordBox], members: &[usize]) -> Line {
    let mut m = members.to_vec();
    m.sort_by(|&a, &b| {
        latin_words[a]
            .x
            .partial_cmp(&latin_words[b].x)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut parts = Vec::new();
    for &i in &m {
        let w = &latin_words[i];
        x0 = x0.min(w.x);
        y0 = y0.min(w.y);
        x1 = x1.max(w.x + w.w);
        y1 = y1.max(w.y + w.h);
        parts.push(w.text.clone());
    }
    Line {
        text: parts.join(" "),
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Which preparation step helps which image: every combination of
    /// enlarge / invert / engines over `RMEMO_OCR_FILES` (`;`-separated).
    /// `cargo test -- --ignored --nocapture compare_variants`
    #[test]
    #[ignore]
    fn compare_variants() {
        let _ = unsafe {
            windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED)
        };
        let mut cached = Vec::new();
        let max_side = OcrEngine::MaxImageDimension().unwrap_or(4096);
        for file in std::env::var("RMEMO_OCR_FILES").unwrap_or_default().split(';').filter(|f| !f.is_empty()) {
            let rgba = image::open(file).unwrap().to_rgba8();
            let (w0, h0) = rgba.dimensions();
            for enlarge in [false, true] {
                for invert in [false, true] {
                    for langs in [vec!["ja"], vec!["en"], vec!["ja", "en"]] {
                        let (px, w, h) = if enlarge { fit(rgba.clone().into_raw(), w0, h0, max_side) } else { (rgba.clone().into_raw(), w0, h0) };
                        let mut bgra = px;
                        for p in bgra.chunks_exact_mut(4) {
                            p.swap(0, 2);
                        }
                        let inverted = invert && maybe_invert(&mut bgra, w as i32, h as i32);
                        let langs: Vec<String> = langs.iter().map(|s| s.to_string()).collect();
                        let text = recognize(&bgra, w as i32, h as i32, &langs, &mut cached).map(|r| r.text).unwrap_or_else(|e| e);
                        eprintln!("===== {} enlarge={enlarge} invert={invert}({inverted}) {langs:?} {w}x{h}\n{text}", file.rsplit('/').next().unwrap());
                    }
                }
            }
        }
    }

    /// Resize filters and factors for the enlarge step, merged engines.
    #[test]
    #[ignore]
    fn compare_upscales() {
        let _ = unsafe {
            windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED)
        };
        let mut cached = Vec::new();
        use image::imageops::FilterType::*;
        for file in std::env::var("RMEMO_OCR_FILES").unwrap_or_default().split(';').filter(|f| !f.is_empty()) {
            let rgba = image::open(file).unwrap().to_rgba8();
            let (w0, h0) = rgba.dimensions();
            for factor in [1.5f64, 2.0, 3.0] {
                for (name, filter) in [("nearest", Nearest), ("triangle", Triangle), ("catmull", CatmullRom), ("lanczos", Lanczos3)] {
                    let (w, h) = ((w0 as f64 * factor) as u32, (h0 as f64 * factor) as u32);
                    let mut bgra = image::imageops::resize(&rgba, w, h, filter).into_raw();
                    for p in bgra.chunks_exact_mut(4) {
                        p.swap(0, 2);
                    }
                    let langs = vec!["ja".to_string(), "en".to_string()];
                    let text = recognize(&bgra, w as i32, h as i32, &langs, &mut cached).map(|r| r.text).unwrap_or_else(|e| e);
                    eprintln!("===== {} x{factor} {name}
{text}", file.rsplit('/').next().unwrap());
                }
            }
        }
    }
}
