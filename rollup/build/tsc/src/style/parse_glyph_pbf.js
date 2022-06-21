import { AlphaImage } from '../util/image';
import Protobuf from 'pbf';
const border = 3;
function readFontstacks(tag, glyphs, pbf) {
    if (tag === 1) {
        pbf.readMessage(readFontstack, glyphs);
    }
}
function readFontstack(tag, glyphs, pbf) {
    if (tag === 3) {
        const { id, bitmap, width, height, left, top, advance } = pbf.readMessage(readGlyph, {});
        glyphs.push({
            id,
            bitmap: new AlphaImage({
                width: width + 2 * border,
                height: height + 2 * border
            }, bitmap),
            metrics: { width, height, left, top, advance }
        });
    }
}
function readGlyph(tag, glyph, pbf) {
    if (tag === 1)
        glyph.id = pbf.readVarint();
    else if (tag === 2)
        glyph.bitmap = pbf.readBytes();
    else if (tag === 3)
        glyph.width = pbf.readVarint();
    else if (tag === 4)
        glyph.height = pbf.readVarint();
    else if (tag === 5)
        glyph.left = pbf.readSVarint();
    else if (tag === 6)
        glyph.top = pbf.readSVarint();
    else if (tag === 7)
        glyph.advance = pbf.readVarint();
}
export default function (data) {
    return new Protobuf(data).readFields(readFontstacks, []);
}
export const GLYPH_PBF_BORDER = border;
//# sourceMappingURL=parse_glyph_pbf.js.map