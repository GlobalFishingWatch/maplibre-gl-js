import { patternUniformValues } from './pattern';
import { Uniform1i, Uniform1f, Uniform2f, Uniform3f, UniformMatrix4f } from '../uniform_binding';
import { extend } from '../../util/util';
const fillUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix)
});
const fillPatternUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_pixel_coord_upper': new Uniform2f(context, locations.u_pixel_coord_upper),
    'u_pixel_coord_lower': new Uniform2f(context, locations.u_pixel_coord_lower),
    'u_scale': new Uniform3f(context, locations.u_scale),
    'u_fade': new Uniform1f(context, locations.u_fade)
});
const fillOutlineUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_world': new Uniform2f(context, locations.u_world)
});
const fillOutlinePatternUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_world': new Uniform2f(context, locations.u_world),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_pixel_coord_upper': new Uniform2f(context, locations.u_pixel_coord_upper),
    'u_pixel_coord_lower': new Uniform2f(context, locations.u_pixel_coord_lower),
    'u_scale': new Uniform3f(context, locations.u_scale),
    'u_fade': new Uniform1f(context, locations.u_fade)
});
const fillUniformValues = (matrix) => ({
    'u_matrix': matrix
});
const fillPatternUniformValues = (matrix, painter, crossfade, tile) => extend(fillUniformValues(matrix), patternUniformValues(crossfade, painter, tile));
const fillOutlineUniformValues = (matrix, drawingBufferSize) => ({
    'u_matrix': matrix,
    'u_world': drawingBufferSize
});
const fillOutlinePatternUniformValues = (matrix, painter, crossfade, tile, drawingBufferSize) => extend(fillPatternUniformValues(matrix, painter, crossfade, tile), {
    'u_world': drawingBufferSize
});
export { fillUniforms, fillPatternUniforms, fillOutlineUniforms, fillOutlinePatternUniforms, fillUniformValues, fillPatternUniformValues, fillOutlineUniformValues, fillOutlinePatternUniformValues };
//# sourceMappingURL=fill_program.js.map