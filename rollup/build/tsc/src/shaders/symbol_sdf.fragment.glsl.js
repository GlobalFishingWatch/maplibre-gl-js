export default "#define SDF_PX 8.0\n\nuniform bool u_is_halo;\nuniform sampler2D u_texture;\nuniform highp float u_gamma_scale;\nuniform lowp float u_device_pixel_ratio;\nuniform bool u_is_text;\n\nvarying vec2 v_data0;\nvarying vec3 v_data1;\n\n#pragma mapbox: define highp vec4 fill_color\n#pragma mapbox: define highp vec4 halo_color\n#pragma mapbox: define lowp float opacity\n#pragma mapbox: define lowp float halo_width\n#pragma mapbox: define lowp float halo_blur\n\nvoid main() {\n    #pragma mapbox: initialize highp vec4 fill_color\n    #pragma mapbox: initialize highp vec4 halo_color\n    #pragma mapbox: initialize lowp float opacity\n    #pragma mapbox: initialize lowp float halo_width\n    #pragma mapbox: initialize lowp float halo_blur\n\n    float EDGE_GAMMA = 0.105 / u_device_pixel_ratio;\n\n    vec2 tex = v_data0.xy;\n    float gamma_scale = v_data1.x;\n    float size = v_data1.y;\n    float fade_opacity = v_data1[2];\n\n    float fontScale = u_is_text ? size / 24.0 : size;\n\n    lowp vec4 color = fill_color;\n    highp float gamma = EDGE_GAMMA / (fontScale * u_gamma_scale);\n    lowp float buff = (256.0 - 64.0) / 256.0;\n    if (u_is_halo) {\n        color = halo_color;\n        gamma = (halo_blur * 1.19 / SDF_PX + EDGE_GAMMA) / (fontScale * u_gamma_scale);\n        buff = (6.0 - halo_width / fontScale) / SDF_PX;\n    }\n\n    lowp float dist = texture2D(u_texture, tex).a;\n    highp float gamma_scaled = gamma * gamma_scale;\n    highp float alpha = smoothstep(buff - gamma_scaled, buff + gamma_scaled, dist);\n\n    gl_FragColor = color * (alpha * opacity * fade_opacity);\n\n#ifdef OVERDRAW_INSPECTOR\n    gl_FragColor = vec4(1.0);\n#endif\n}\n";