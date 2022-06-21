import { Uniform1i, Uniform1f, Uniform2f, Uniform3f, UniformMatrix4f } from '../uniform_binding';
import pixelsToTileUnits from '../../source/pixels_to_tile_units';
import { extend } from '../../util/util';
const lineUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_ratio': new Uniform1f(context, locations.u_ratio),
    'u_device_pixel_ratio': new Uniform1f(context, locations.u_device_pixel_ratio),
    'u_units_to_pixels': new Uniform2f(context, locations.u_units_to_pixels)
});
const lineGradientUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_ratio': new Uniform1f(context, locations.u_ratio),
    'u_device_pixel_ratio': new Uniform1f(context, locations.u_device_pixel_ratio),
    'u_units_to_pixels': new Uniform2f(context, locations.u_units_to_pixels),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_image_height': new Uniform1f(context, locations.u_image_height)
});
const linePatternUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_ratio': new Uniform1f(context, locations.u_ratio),
    'u_device_pixel_ratio': new Uniform1f(context, locations.u_device_pixel_ratio),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_units_to_pixels': new Uniform2f(context, locations.u_units_to_pixels),
    'u_scale': new Uniform3f(context, locations.u_scale),
    'u_fade': new Uniform1f(context, locations.u_fade)
});
const lineSDFUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_ratio': new Uniform1f(context, locations.u_ratio),
    'u_device_pixel_ratio': new Uniform1f(context, locations.u_device_pixel_ratio),
    'u_units_to_pixels': new Uniform2f(context, locations.u_units_to_pixels),
    'u_patternscale_a': new Uniform2f(context, locations.u_patternscale_a),
    'u_patternscale_b': new Uniform2f(context, locations.u_patternscale_b),
    'u_sdfgamma': new Uniform1f(context, locations.u_sdfgamma),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_tex_y_a': new Uniform1f(context, locations.u_tex_y_a),
    'u_tex_y_b': new Uniform1f(context, locations.u_tex_y_b),
    'u_mix': new Uniform1f(context, locations.u_mix)
});
const lineUniformValues = (painter, tile, layer) => {
    const transform = painter.transform;
    return {
        'u_matrix': calculateMatrix(painter, tile, layer),
        'u_ratio': 1 / pixelsToTileUnits(tile, 1, transform.zoom),
        'u_device_pixel_ratio': painter.pixelRatio,
        'u_units_to_pixels': [
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1]
        ]
    };
};
const lineGradientUniformValues = (painter, tile, layer, imageHeight) => {
    return extend(lineUniformValues(painter, tile, layer), {
        'u_image': 0,
        'u_image_height': imageHeight,
    });
};
const linePatternUniformValues = (painter, tile, layer, crossfade) => {
    const transform = painter.transform;
    const tileZoomRatio = calculateTileRatio(tile, transform);
    return {
        'u_matrix': calculateMatrix(painter, tile, layer),
        'u_texsize': tile.imageAtlasTexture.size,
        // camera zoom ratio
        'u_ratio': 1 / pixelsToTileUnits(tile, 1, transform.zoom),
        'u_device_pixel_ratio': painter.pixelRatio,
        'u_image': 0,
        'u_scale': [tileZoomRatio, crossfade.fromScale, crossfade.toScale],
        'u_fade': crossfade.t,
        'u_units_to_pixels': [
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1]
        ]
    };
};
const lineSDFUniformValues = (painter, tile, layer, dasharray, crossfade) => {
    const transform = painter.transform;
    const lineAtlas = painter.lineAtlas;
    const tileRatio = calculateTileRatio(tile, transform);
    const round = layer.layout.get('line-cap') === 'round';
    const posA = lineAtlas.getDash(dasharray.from, round);
    const posB = lineAtlas.getDash(dasharray.to, round);
    const widthA = posA.width * crossfade.fromScale;
    const widthB = posB.width * crossfade.toScale;
    return extend(lineUniformValues(painter, tile, layer), {
        'u_patternscale_a': [tileRatio / widthA, -posA.height / 2],
        'u_patternscale_b': [tileRatio / widthB, -posB.height / 2],
        'u_sdfgamma': lineAtlas.width / (Math.min(widthA, widthB) * 256 * painter.pixelRatio) / 2,
        'u_image': 0,
        'u_tex_y_a': posA.y,
        'u_tex_y_b': posB.y,
        'u_mix': crossfade.t
    });
};
function calculateTileRatio(tile, transform) {
    return 1 / pixelsToTileUnits(tile, 1, transform.tileZoom);
}
function calculateMatrix(painter, tile, layer) {
    return painter.translatePosMatrix(tile.tileID.posMatrix, tile, layer.paint.get('line-translate'), layer.paint.get('line-translate-anchor'));
}
export { lineUniforms, lineGradientUniforms, linePatternUniforms, lineSDFUniforms, lineUniformValues, lineGradientUniformValues, linePatternUniformValues, lineSDFUniformValues };
//# sourceMappingURL=line_program.js.map