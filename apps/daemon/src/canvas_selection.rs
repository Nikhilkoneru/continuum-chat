use anyhow::bail;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionContextExcerpt {
    pub before: String,
    pub after: String,
    pub before_truncated: bool,
    pub after_truncated: bool,
}

fn char_offset_to_byte_index(input: &str, char_offset: usize) -> usize {
    input
        .char_indices()
        .nth(char_offset)
        .map(|(index, _)| index)
        .unwrap_or(input.len())
}

fn slice_char_range(input: &str, start: usize, end: usize) -> &str {
    let byte_start = char_offset_to_byte_index(input, start);
    let byte_end = char_offset_to_byte_index(input, end);
    &input[byte_start..byte_end]
}

pub fn utf16_offset_to_byte_index(input: &str, utf16_offset: usize) -> anyhow::Result<usize> {
    let mut consumed_utf16 = 0usize;
    for (byte_index, ch) in input.char_indices() {
        if consumed_utf16 == utf16_offset {
            return Ok(byte_index);
        }

        consumed_utf16 += ch.len_utf16();
        if consumed_utf16 > utf16_offset {
            bail!("Selection offset {utf16_offset} is not aligned to a UTF-16 boundary.");
        }
    }

    if consumed_utf16 == utf16_offset {
        Ok(input.len())
    } else {
        bail!("Selection offset {utf16_offset} is out of bounds for the current document.");
    }
}

pub fn utf16_range_to_byte_range(
    input: &str,
    start_utf16: usize,
    end_utf16: usize,
) -> anyhow::Result<(usize, usize)> {
    if start_utf16 > end_utf16 {
        bail!("Selection start must be less than or equal to selection end.");
    }

    let byte_start = utf16_offset_to_byte_index(input, start_utf16)?;
    let byte_end = utf16_offset_to_byte_index(input, end_utf16)?;
    Ok((byte_start, byte_end))
}

pub fn build_selection_context_excerpt(
    input: &str,
    start_utf16: usize,
    end_utf16: usize,
    radius_chars: usize,
) -> anyhow::Result<SelectionContextExcerpt> {
    let (byte_start, byte_end) = utf16_range_to_byte_range(input, start_utf16, end_utf16)?;
    let before_full = &input[..byte_start];
    let after_full = &input[byte_end..];

    let before_char_count = before_full.chars().count();
    let before_start = before_char_count.saturating_sub(radius_chars);
    let after_char_count = after_full.chars().count();
    let after_end = radius_chars.min(after_char_count);

    Ok(SelectionContextExcerpt {
        before: slice_char_range(before_full, before_start, before_char_count).to_string(),
        after: slice_char_range(after_full, 0, after_end).to_string(),
        before_truncated: before_start > 0,
        after_truncated: after_end < after_char_count,
    })
}

pub fn splice_utf16_selection(
    input: &str,
    start_utf16: usize,
    end_utf16: usize,
    expected_selection_text: &str,
    replacement: &str,
) -> anyhow::Result<String> {
    let (byte_start, byte_end) = utf16_range_to_byte_range(input, start_utf16, end_utf16)?;
    let selected = &input[byte_start..byte_end];
    if selected != expected_selection_text {
        bail!("The selected text no longer matches the current canvas content.");
    }

    let mut output =
        String::with_capacity(input.len() - (byte_end - byte_start) + replacement.len());
    output.push_str(&input[..byte_start]);
    output.push_str(replacement);
    output.push_str(&input[byte_end..]);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{build_selection_context_excerpt, splice_utf16_selection};

    #[test]
    fn selection_context_excerpt_uses_utf16_offsets() {
        let excerpt = build_selection_context_excerpt("aa🙂bbccdd", 2, 4, 2).unwrap();

        assert_eq!(excerpt.before, "aa");
        assert_eq!(excerpt.after, "bb");
        assert!(!excerpt.before_truncated);
        assert!(excerpt.after_truncated);
    }

    #[test]
    fn splice_utf16_selection_preserves_unicode_boundaries() {
        let updated = splice_utf16_selection("hello 🙂 world", 6, 8, "🙂", "🚀").unwrap();

        assert_eq!(updated, "hello 🚀 world");
    }

    #[test]
    fn splice_utf16_selection_rejects_mismatched_selected_text() {
        let error = splice_utf16_selection("hello 🙂 world", 6, 8, "🙃", "🚀").unwrap_err();

        assert!(error
            .to_string()
            .contains("selected text no longer matches"));
    }
}
