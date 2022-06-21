import { getArrayBuffer, ResourceType } from '../util/ajax';
import parseGlyphPBF from './parse_glyph_pbf';
export default function loadGlyphRange(fontstack, range, urlTemplate, requestManager, callback) {
    const begin = range * 256;
    const end = begin + 255;
    const request = requestManager.transformRequest(urlTemplate.replace('{fontstack}', fontstack).replace('{range}', `${begin}-${end}`), ResourceType.Glyphs);
    getArrayBuffer(request, (err, data) => {
        if (err) {
            callback(err);
        }
        else if (data) {
            const glyphs = {};
            for (const glyph of parseGlyphPBF(data)) {
                glyphs[glyph.id] = glyph;
            }
            callback(null, glyphs);
        }
    });
}
//# sourceMappingURL=load_glyph_range.js.map