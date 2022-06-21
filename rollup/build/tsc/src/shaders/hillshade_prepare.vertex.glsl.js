export default "uniform mat4 u_matrix;\nuniform vec2 u_dimension;\n\nattribute vec2 a_pos;\nattribute vec2 a_texture_pos;\n\nvarying vec2 v_pos;\n\nvoid main() {\n    gl_Position = u_matrix * vec4(a_pos, 0, 1);\n\n    highp vec2 epsilon = 1.0 / u_dimension;\n    float scale = (u_dimension.x - 2.0) / u_dimension.x;\n    v_pos = (a_texture_pos / 8192.0) * scale + epsilon;\n}\n";