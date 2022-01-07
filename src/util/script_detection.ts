/* eslint-disable new-cap */

import isChar from './is_char_in_unicode_block';

export function allowsIdeographicBreaking(chars: string) {
    for (const char of chars) {
        if (!charAllowsIdeographicBreaking(char.charCodeAt(0))) return false;
    }
    return true;
}

export function allowsVerticalWritingMode(chars: string) {
    for (const char of chars) {
        if (charHasUprightVerticalOrientation(char.charCodeAt(0))) return true;
    }
    return false;
}

export function allowsLetterSpacing(chars: string) {
    for (const char of chars) {
        if (!charAllowsLetterSpacing(char.charCodeAt(0))) return false;
    }
    return true;
}

export function charAllowsLetterSpacing(char: number) {
    if (isChar['Arabic'](char)) return false;
    if (isChar['Arabic Supplement'](char)) return false;
    if (isChar['Arabic Extended-A'](char)) return false;
    if (isChar['Arabic Presentation Forms-A'](char)) return false;
    if (isChar['Arabic Presentation Forms-B'](char)) return false;

    return true;
}

export function charAllowsIdeographicBreaking(char: number) {
    // Return early for characters outside all ideographic ranges.
    if (char < 0x2e80) return false;

    if (isChar['Bopomofo Extended'](char)) return true;
    if (isChar['Bopomofo'](char)) return true;
    if (isChar['CJK Compatibility Forms'](char)) return true;
    if (isChar['CJK Compatibility Ideographs'](char)) return true;
    if (isChar['CJK Compatibility'](char)) return true;
    if (isChar['CJK Radicals Supplement'](char)) return true;
    if (isChar['CJK Strokes'](char)) return true;
    if (isChar['CJK Symbols and Punctuation'](char)) return true;
    if (isChar['CJK Unified Ideographs Extension A'](char)) return true;
    if (isChar['CJK Unified Ideographs'](char)) return true;
    if (isChar['Enclosed CJK Letters and Months'](char)) return true;
    if (isChar['Halfwidth and Fullwidth Forms'](char)) return true;
    if (isChar['Hiragana'](char)) return true;
    if (isChar['Ideographic Description Characters'](char)) return true;
    if (isChar['Kangxi Radicals'](char)) return true;
    if (isChar['Katakana Phonetic Extensions'](char)) return true;
    if (isChar['Katakana'](char)) return true;
    if (isChar['Vertical Forms'](char)) return true;
    if (isChar['Yi Radicals'](char)) return true;
    if (isChar['Yi Syllables'](char)) return true;

    return false;
}

// The following logic comes from
// <http://www.unicode.org/Public/12.0.0/ucd/VerticalOrientation.txt>.
// Keep it synchronized with
// <http://www.unicode.org/Public/UCD/latest/ucd/VerticalOrientation.txt>.
// The data file denotes with “U” or “Tu” any codepoint that may be drawn
// upright in vertical text but does not distinguish between upright and
// “neutral” characters.

// Blocks in the Unicode supplementary planes are excluded from this module due
// to <https://github.com/mapbox/mapbox-gl/issues/29>.

/**
 * Returns true if the given Unicode codepoint identifies a character with
 * upright orientation.
 *
 * A character has upright orientation if it is drawn upright (unrotated)
 * whether the line is oriented horizontally or vertically, even if both
 * adjacent characters can be rotated. For example, a Chinese character is
 * always drawn upright. An uprightly oriented character causes an adjacent
 * “neutral” character to be drawn upright as well.
 * @private
 */
export function charHasUprightVerticalOrientation(char: number) {
    if (
        char === 0x02ea /* modifier letter yin departing tone mark */ ||
        char === 0x02eb /* modifier letter yang departing tone mark */
    ) {
        return true;
    }

    // Return early for characters outside all ranges whose characters remain
    // upright in vertical writing mode.
    if (char < 0x1100) return false;

    if (isChar['Bopomofo Extended'](char)) return true;
    if (isChar['Bopomofo'](char)) return true;
    if (isChar['CJK Compatibility Forms'](char)) {
        if (!((char >= 0xfe49 /* dashed overline */ && char <= 0xfe4f) /* wavy low line */)) {
            return true;
        }
    }
    if (isChar['CJK Compatibility Ideographs'](char)) return true;
    if (isChar['CJK Compatibility'](char)) return true;
    if (isChar['CJK Radicals Supplement'](char)) return true;
    if (isChar['CJK Strokes'](char)) return true;
    if (isChar['CJK Symbols and Punctuation'](char)) {
        if (
            !((char >= 0x3008 /* left angle bracket */ && char <= 0x3011) /* right black lenticular bracket */) &&
            !(
                (
                    char >= 0x3014 /* left tortoise shell bracket */ && char <= 0x301f
                ) /* low double prime quotation mark */
            ) &&
            char !== 0x3030 /* wavy dash */
        ) {
            return true;
        }
    }
    if (isChar['CJK Unified Ideographs Extension A'](char)) return true;
    if (isChar['CJK Unified Ideographs'](char)) return true;
    if (isChar['Enclosed CJK Letters and Months'](char)) return true;
    if (isChar['Hangul Compatibility Jamo'](char)) return true;
    if (isChar['Hangul Jamo Extended-A'](char)) return true;
    if (isChar['Hangul Jamo Extended-B'](char)) return true;
    if (isChar['Hangul Jamo'](char)) return true;
    if (isChar['Hangul Syllables'](char)) return true;
    if (isChar['Hiragana'](char)) return true;
    if (isChar['Ideographic Description Characters'](char)) return true;
    if (isChar['Kanbun'](char)) return true;
    if (isChar['Kangxi Radicals'](char)) return true;
    if (isChar['Katakana Phonetic Extensions'](char)) return true;
    if (isChar['Katakana'](char)) {
        if (char !== 0x30fc /* katakana-hiragana prolonged sound mark */) {
            return true;
        }
    }
    if (isChar['Halfwidth and Fullwidth Forms'](char)) {
        if (
            char !== 0xff08 /* fullwidth left parenthesis */ &&
            char !== 0xff09 /* fullwidth right parenthesis */ &&
            char !== 0xff0d /* fullwidth hyphen-minus */ &&
            !((char >= 0xff1a /* fullwidth colon */ && char <= 0xff1e) /* fullwidth greater-than sign */) &&
            char !== 0xff3b /* fullwidth left square bracket */ &&
            char !== 0xff3d /* fullwidth right square bracket */ &&
            char !== 0xff3f /* fullwidth low line */ &&
            !(char >= 0xff5b /* fullwidth left curly bracket */ && char <= 0xffdf) &&
            char !== 0xffe3 /* fullwidth macron */ &&
            !(char >= 0xffe8 /* halfwidth forms light vertical */ && char <= 0xffef)
        ) {
            return true;
        }
    }
    if (isChar['Small Form Variants'](char)) {
        if (
            !((char >= 0xfe58 /* small em dash */ && char <= 0xfe5e) /* small right tortoise shell bracket */) &&
            !((char >= 0xfe63 /* small hyphen-minus */ && char <= 0xfe66) /* small equals sign */)
        ) {
            return true;
        }
    }
    if (isChar['Unified Canadian Aboriginal Syllabics'](char)) return true;
    if (isChar['Unified Canadian Aboriginal Syllabics Extended'](char)) return true;
    if (isChar['Vertical Forms'](char)) return true;
    if (isChar['Yijing Hexagram Symbols'](char)) return true;
    if (isChar['Yi Syllables'](char)) return true;
    if (isChar['Yi Radicals'](char)) return true;

    return false;
}

/**
 * Returns true if the given Unicode codepoint identifies a character with
 * neutral orientation.
 *
 * A character has neutral orientation if it may be drawn rotated or unrotated
 * when the line is oriented vertically, depending on the orientation of the
 * adjacent characters. For example, along a verticlly oriented line, the vulgar
 * fraction ½ is drawn upright among Chinese characters but rotated among Latin
 * letters. A neutrally oriented character does not influence whether an
 * adjacent character is drawn upright or rotated.
 * @private
 */
export function charHasNeutralVerticalOrientation(char: number) {
    if (isChar['Latin-1 Supplement'](char)) {
        if (
            char === 0x00a7 /* section sign */ ||
            char === 0x00a9 /* copyright sign */ ||
            char === 0x00ae /* registered sign */ ||
            char === 0x00b1 /* plus-minus sign */ ||
            char === 0x00bc /* vulgar fraction one quarter */ ||
            char === 0x00bd /* vulgar fraction one half */ ||
            char === 0x00be /* vulgar fraction three quarters */ ||
            char === 0x00d7 /* multiplication sign */ ||
            char === 0x00f7 /* division sign */
        ) {
            return true;
        }
    }
    if (isChar['General Punctuation'](char)) {
        if (
            char === 0x2016 /* double vertical line */ ||
            char === 0x2020 /* dagger */ ||
            char === 0x2021 /* double dagger */ ||
            char === 0x2030 /* per mille sign */ ||
            char === 0x2031 /* per ten thousand sign */ ||
            char === 0x203b /* reference mark */ ||
            char === 0x203c /* double exclamation mark */ ||
            char === 0x2042 /* asterism */ ||
            char === 0x2047 /* double question mark */ ||
            char === 0x2048 /* question exclamation mark */ ||
            char === 0x2049 /* exclamation question mark */ ||
            char === 0x2051 /* two asterisks aligned vertically */
        ) {
            return true;
        }
    }
    if (isChar['Letterlike Symbols'](char)) return true;
    if (isChar['Number Forms'](char)) return true;
    if (isChar['Miscellaneous Technical'](char)) {
        if (
            (char >= 0x2300 /* diameter sign */ && char <= 0x2307) /* wavy line */ ||
            (char >= 0x230c /* bottom right crop */ && char <= 0x231f) /* bottom right corner */ ||
            (char >= 0x2324 /* up arrowhead between two horizontal bars */ && char <= 0x2328) /* keyboard */ ||
            char === 0x232b /* erase to the left */ ||
            (char >= 0x237d /* shouldered open box */ && char <= 0x239a) /* clear screen symbol */ ||
            (char >= 0x23be /* dentistry symbol light vertical and top right */ && char <= 0x23cd) /* square foot */ ||
            char === 0x23cf /* eject symbol */ ||
            (char >= 0x23d1 /* metrical breve */ && char <= 0x23db) /* fuse */ ||
            (char >= 0x23e2 /* white trapezium */ && char <= 0x23ff)
        ) {
            return true;
        }
    }
    if (isChar['Control Pictures'](char) && char !== 0x2423 /* open box */) return true;
    if (isChar['Optical Character Recognition'](char)) return true;
    if (isChar['Enclosed Alphanumerics'](char)) return true;
    if (isChar['Geometric Shapes'](char)) return true;
    if (isChar['Miscellaneous Symbols'](char)) {
        if (!((char >= 0x261a /* black left pointing index */ && char <= 0x261f) /* white down pointing index */)) {
            return true;
        }
    }
    if (isChar['Miscellaneous Symbols and Arrows'](char)) {
        if (
            (char >= 0x2b12 /* square with top half black */ && char <= 0x2b2f) /* white vertical ellipse */ ||
            (char >= 0x2b50 /* white medium star */ && char <= 0x2b59) /* heavy circled saltire */ ||
            (char >= 0x2bb8 /* upwards white arrow from bar with horizontal bar */ && char <= 0x2beb)
        ) {
            return true;
        }
    }
    if (isChar['CJK Symbols and Punctuation'](char)) return true;
    if (isChar['Katakana'](char)) return true;
    if (isChar['Private Use Area'](char)) return true;
    if (isChar['CJK Compatibility Forms'](char)) return true;
    if (isChar['Small Form Variants'](char)) return true;
    if (isChar['Halfwidth and Fullwidth Forms'](char)) return true;

    if (
        char === 0x221e /* infinity */ ||
        char === 0x2234 /* therefore */ ||
        char === 0x2235 /* because */ ||
        (char >= 0x2700 /* black safety scissors */ && char <= 0x2767) /* rotated floral heart bullet */ ||
        (char >= 0x2776 /* dingbat negative circled digit one */ &&
            char <= 0x2793) /* dingbat negative circled sans-serif number ten */ ||
        char === 0xfffc /* object replacement character */ ||
        char === 0xfffd /* replacement character */
    ) {
        return true;
    }

    return false;
}

/**
 * Returns true if the given Unicode codepoint identifies a character with
 * rotated orientation.
 *
 * A character has rotated orientation if it is drawn rotated when the line is
 * oriented vertically, even if both adjacent characters are upright. For
 * example, a Latin letter is drawn rotated along a vertical line. A rotated
 * character causes an adjacent “neutral” character to be drawn rotated as well.
 * @private
 */
export function charHasRotatedVerticalOrientation(char: number) {
    return !(charHasUprightVerticalOrientation(char) || charHasNeutralVerticalOrientation(char));
}

export function charInComplexShapingScript(char: number) {
    return (
        isChar['Arabic'](char) ||
        isChar['Arabic Supplement'](char) ||
        isChar['Arabic Extended-A'](char) ||
        isChar['Arabic Presentation Forms-A'](char) ||
        isChar['Arabic Presentation Forms-B'](char)
    );
}

export function charInRTLScript(char: number) {
    // Main blocks for Hebrew, Arabic, Thaana and other RTL scripts
    return (
        (char >= 0x0590 && char <= 0x08ff) ||
        isChar['Arabic Presentation Forms-A'](char) ||
        isChar['Arabic Presentation Forms-B'](char)
    );
}

export function charInSupportedScript(char: number, canRenderRTL: boolean) {
    // This is a rough heuristic: whether we "can render" a script
    // actually depends on the properties of the font being used
    // and whether differences from the ideal rendering are considered
    // semantically significant.

    // Even in Latin script, we "can't render" combinations such as the fi
    // ligature, but we don't consider that semantically significant.
    if (!canRenderRTL && charInRTLScript(char)) {
        return false;
    }
    if (
        (char >= 0x0900 && char <= 0x0dff) ||
        // Main blocks for Indic scripts and Sinhala
        (char >= 0x0f00 && char <= 0x109f) ||
        // Main blocks for Tibetan and Myanmar
        isChar['Khmer'](char)
    ) {
        // These blocks cover common scripts that require
        // complex text shaping, based on unicode script metadata:
        // http://www.unicode.org/repos/cldr/trunk/common/properties/scriptMetadata.txt
        // where "Web Rank <= 32" "Shaping Required = YES"
        return false;
    }
    return true;
}

export function stringContainsRTLText(chars: string): boolean {
    for (const char of chars) {
        if (charInRTLScript(char.charCodeAt(0))) {
            return true;
        }
    }
    return false;
}

export function isStringInSupportedScript(chars: string, canRenderRTL: boolean) {
    for (const char of chars) {
        if (!charInSupportedScript(char.charCodeAt(0), canRenderRTL)) {
            return false;
        }
    }
    return true;
}
