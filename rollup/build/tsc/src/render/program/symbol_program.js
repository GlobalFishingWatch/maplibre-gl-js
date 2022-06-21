import { Uniform1i, Uniform1f, Uniform2f, UniformMatrix4f } from '../uniform_binding';
import { extend } from '../../util/util';
const symbolIconUniforms = (context, locations) => ({
    'u_is_size_zoom_constant': new Uniform1i(context, locations.u_is_size_zoom_constant),
    'u_is_size_feature_constant': new Uniform1i(context, locations.u_is_size_feature_constant),
    'u_size_t': new Uniform1f(context, locations.u_size_t),
    'u_size': new Uniform1f(context, locations.u_size),
    'u_camera_to_center_distance': new Uniform1f(context, locations.u_camera_to_center_distance),
    'u_pitch': new Uniform1f(context, locations.u_pitch),
    'u_rotate_symbol': new Uniform1i(context, locations.u_rotate_symbol),
    'u_aspect_ratio': new Uniform1f(context, locations.u_aspect_ratio),
    'u_fade_change': new Uniform1f(context, locations.u_fade_change),
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_label_plane_matrix': new UniformMatrix4f(context, locations.u_label_plane_matrix),
    'u_coord_matrix': new UniformMatrix4f(context, locations.u_coord_matrix),
    'u_is_text': new Uniform1i(context, locations.u_is_text),
    'u_pitch_with_map': new Uniform1i(context, locations.u_pitch_with_map),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_texture': new Uniform1i(context, locations.u_texture)
});
const symbolSDFUniforms = (context, locations) => ({
    'u_is_size_zoom_constant': new Uniform1i(context, locations.u_is_size_zoom_constant),
    'u_is_size_feature_constant': new Uniform1i(context, locations.u_is_size_feature_constant),
    'u_size_t': new Uniform1f(context, locations.u_size_t),
    'u_size': new Uniform1f(context, locations.u_size),
    'u_camera_to_center_distance': new Uniform1f(context, locations.u_camera_to_center_distance),
    'u_pitch': new Uniform1f(context, locations.u_pitch),
    'u_rotate_symbol': new Uniform1i(context, locations.u_rotate_symbol),
    'u_aspect_ratio': new Uniform1f(context, locations.u_aspect_ratio),
    'u_fade_change': new Uniform1f(context, locations.u_fade_change),
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_label_plane_matrix': new UniformMatrix4f(context, locations.u_label_plane_matrix),
    'u_coord_matrix': new UniformMatrix4f(context, locations.u_coord_matrix),
    'u_is_text': new Uniform1i(context, locations.u_is_text),
    'u_pitch_with_map': new Uniform1i(context, locations.u_pitch_with_map),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_texture': new Uniform1i(context, locations.u_texture),
    'u_gamma_scale': new Uniform1f(context, locations.u_gamma_scale),
    'u_device_pixel_ratio': new Uniform1f(context, locations.u_device_pixel_ratio),
    'u_is_halo': new Uniform1i(context, locations.u_is_halo)
});
const symbolTextAndIconUniforms = (context, locations) => ({
    'u_is_size_zoom_constant': new Uniform1i(context, locations.u_is_size_zoom_constant),
    'u_is_size_feature_constant': new Uniform1i(context, locations.u_is_size_feature_constant),
    'u_size_t': new Uniform1f(context, locations.u_size_t),
    'u_size': new Uniform1f(context, locations.u_size),
    'u_camera_to_center_distance': new Uniform1f(context, locations.u_camera_to_center_distance),
    'u_pitch': new Uniform1f(context, locations.u_pitch),
    'u_rotate_symbol': new Uniform1i(context, locations.u_rotate_symbol),
    'u_aspect_ratio': new Uniform1f(context, locations.u_aspect_ratio),
    'u_fade_change': new Uniform1f(context, locations.u_fade_change),
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_label_plane_matrix': new UniformMatrix4f(context, locations.u_label_plane_matrix),
    'u_coord_matrix': new UniformMatrix4f(context, locations.u_coord_matrix),
    'u_is_text': new Uniform1i(context, locations.u_is_text),
    'u_pitch_with_map': new Uniform1i(context, locations.u_pitch_with_map),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_texsize_icon': new Uniform2f(context, locations.u_texsize_icon),
    'u_texture': new Uniform1i(context, locations.u_texture),
    'u_texture_icon': new Uniform1i(context, locations.u_texture_icon),
    'u_gamma_scale': new Uniform1f(context, locations.u_gamma_scale),
    'u_device_pixel_ratio': new Uniform1f(context, locations.u_device_pixel_ratio),
    'u_is_halo': new Uniform1i(context, locations.u_is_halo)
});
const symbolIconUniformValues = (functionType, size, rotateInShader, pitchWithMap, painter, matrix, labelPlaneMatrix, glCoordMatrix, isText, texSize) => {
    const transform = painter.transform;
    return {
        'u_is_size_zoom_constant': +(functionType === 'constant' || functionType === 'source'),
        'u_is_size_feature_constant': +(functionType === 'constant' || functionType === 'camera'),
        'u_size_t': size ? size.uSizeT : 0,
        'u_size': size ? size.uSize : 0,
        'u_camera_to_center_distance': transform.cameraToCenterDistance,
        'u_pitch': transform.pitch / 360 * 2 * Math.PI,
        'u_rotate_symbol': +rotateInShader,
        'u_aspect_ratio': transform.width / transform.height,
        'u_fade_change': painter.options.fadeDuration ? painter.symbolFadeChange : 1,
        'u_matrix': matrix,
        'u_label_plane_matrix': labelPlaneMatrix,
        'u_coord_matrix': glCoordMatrix,
        'u_is_text': +isText,
        'u_pitch_with_map': +pitchWithMap,
        'u_texsize': texSize,
        'u_texture': 0
    };
};
const symbolSDFUniformValues = (functionType, size, rotateInShader, pitchWithMap, painter, matrix, labelPlaneMatrix, glCoordMatrix, isText, texSize, isHalo) => {
    const transform = painter.transform;
    return extend(symbolIconUniformValues(functionType, size, rotateInShader, pitchWithMap, painter, matrix, labelPlaneMatrix, glCoordMatrix, isText, texSize), {
        'u_gamma_scale': (pitchWithMap ? Math.cos(transform._pitch) * transform.cameraToCenterDistance : 1),
        'u_device_pixel_ratio': painter.pixelRatio,
        'u_is_halo': +isHalo
    });
};
const symbolTextAndIconUniformValues = (functionType, size, rotateInShader, pitchWithMap, painter, matrix, labelPlaneMatrix, glCoordMatrix, texSizeSDF, texSizeIcon) => {
    return extend(symbolSDFUniformValues(functionType, size, rotateInShader, pitchWithMap, painter, matrix, labelPlaneMatrix, glCoordMatrix, true, texSizeSDF, true), {
        'u_texsize_icon': texSizeIcon,
        'u_texture_icon': 1
    });
};
export { symbolIconUniforms, symbolSDFUniforms, symbolIconUniformValues, symbolSDFUniformValues, symbolTextAndIconUniformValues, symbolTextAndIconUniforms };
//# sourceMappingURL=symbol_program.js.map