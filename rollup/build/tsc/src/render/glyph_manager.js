import loadGlyphRange from '../style/load_glyph_range';
import TinySDF from '@mapbox/tiny-sdf';
import isChar from '../util/is_char_in_unicode_block';
import { asyncAll } from '../util/util';
import { AlphaImage } from '../util/image';
export default class GlyphManager {
    constructor(requestManager, localIdeographFontFamily) {
        this.requestManager = requestManager;
        this.localIdeographFontFamily = localIdeographFontFamily;
        this.entries = {};
    }
    setURL(url) {
        this.url = url;
    }
    getGlyphs(glyphs, callback) {
        const all = [];
        for (const stack in glyphs) {
            for (const id of glyphs[stack]) {
                all.push({ stack, id });
            }
        }
        asyncAll(all, ({ stack, id }, callback) => {
            let entry = this.entries[stack];
            if (!entry) {
                entry = this.entries[stack] = {
                    glyphs: {},
                    requests: {},
                    ranges: {}
                };
            }
            let glyph = entry.glyphs[id];
            if (glyph !== undefined) {
                callback(null, { stack, id, glyph });
                return;
            }
            glyph = this._tinySDF(entry, stack, id);
            if (glyph) {
                entry.glyphs[id] = glyph;
                callback(null, { stack, id, glyph });
                return;
            }
            const range = Math.floor(id / 256);
            if (range * 256 > 65535) {
                callback(new Error('glyphs > 65535 not supported'));
                return;
            }
            if (entry.ranges[range]) {
                callback(null, { stack, id, glyph });
                return;
            }
            let requests = entry.requests[range];
            if (!requests) {
                requests = entry.requests[range] = [];
                GlyphManager.loadGlyphRange(stack, range, this.url, this.requestManager, (err, response) => {
                    if (response) {
                        for (const id in response) {
                            if (!this._doesCharSupportLocalGlyph(+id)) {
                                entry.glyphs[+id] = response[+id];
                            }
                        }
                        entry.ranges[range] = true;
                    }
                    for (const cb of requests) {
                        cb(err, response);
                    }
                    delete entry.requests[range];
                });
            }
            requests.push((err, result) => {
                if (err) {
                    callback(err);
                }
                else if (result) {
                    callback(null, { stack, id, glyph: result[id] || null });
                }
            });
        }, (err, glyphs) => {
            if (err) {
                callback(err);
            }
            else if (glyphs) {
                const result = {};
                for (const { stack, id, glyph } of glyphs) {
                    // Clone the glyph so that our own copy of its ArrayBuffer doesn't get transferred.
                    (result[stack] || (result[stack] = {}))[id] = glyph && {
                        id: glyph.id,
                        bitmap: glyph.bitmap.clone(),
                        metrics: glyph.metrics
                    };
                }
                callback(null, result);
            }
        });
    }
    _doesCharSupportLocalGlyph(id) {
        /* eslint-disable new-cap */
        return !!this.localIdeographFontFamily &&
            (isChar['CJK Unified Ideographs'](id) ||
                isChar['Hangul Syllables'](id) ||
                isChar['Hiragana'](id) ||
                isChar['Katakana'](id));
        /* eslint-enable new-cap */
    }
    _tinySDF(entry, stack, id) {
        const fontFamily = this.localIdeographFontFamily;
        if (!fontFamily) {
            return;
        }
        if (!this._doesCharSupportLocalGlyph(id)) {
            return;
        }
        let tinySDF = entry.tinySDF;
        if (!tinySDF) {
            let fontWeight = '400';
            if (/bold/i.test(stack)) {
                fontWeight = '900';
            }
            else if (/medium/i.test(stack)) {
                fontWeight = '500';
            }
            else if (/light/i.test(stack)) {
                fontWeight = '200';
            }
            tinySDF = entry.tinySDF = new GlyphManager.TinySDF({
                fontSize: 24,
                buffer: 3,
                radius: 8,
                cutoff: 0.25,
                fontFamily,
                fontWeight
            });
        }
        const char = tinySDF.draw(String.fromCharCode(id));
        return {
            id,
            bitmap: new AlphaImage({ width: char.width || 30, height: char.height || 30 }, char.data),
            metrics: {
                width: char.glyphWidth || 24,
                height: char.glyphHeight || 24,
                left: char.glyphLeft || 0,
                top: char.glyphTop || -8,
                advance: char.glyphAdvance || 24
            }
        };
    }
}
// exposed as statics to enable stubbing in unit tests
GlyphManager.loadGlyphRange = loadGlyphRange;
GlyphManager.TinySDF = TinySDF;
//# sourceMappingURL=glyph_manager.js.map