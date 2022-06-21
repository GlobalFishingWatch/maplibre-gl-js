var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
class GeoJSONFeature {
    constructor(vectorTileFeature, z, x, y, id) {
        this.type = 'Feature';
        this._vectorTileFeature = vectorTileFeature;
        vectorTileFeature._z = z;
        vectorTileFeature._x = x;
        vectorTileFeature._y = y;
        this.properties = vectorTileFeature.properties;
        this.id = id;
    }
    get geometry() {
        if (this._geometry === undefined) {
            this._geometry = this._vectorTileFeature.toGeoJSON(this._vectorTileFeature._x, this._vectorTileFeature._y, this._vectorTileFeature._z).geometry;
        }
        return this._geometry;
    }
    set geometry(g) {
        this._geometry = g;
    }
    toJSON() {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _a = this, { _geometry, _vectorTileFeature } = _a, json = __rest(_a, ["_geometry", "_vectorTileFeature"]);
        json.geometry = this.geometry;
        return json;
    }
}
export default GeoJSONFeature;
//# sourceMappingURL=vectortile_to_geojson.js.map