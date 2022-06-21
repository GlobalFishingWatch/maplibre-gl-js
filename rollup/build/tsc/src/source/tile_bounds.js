import LngLatBounds from '../geo/lng_lat_bounds';
import { mercatorXfromLng, mercatorYfromLat } from '../geo/mercator_coordinate';
class TileBounds {
    constructor(bounds, minzoom, maxzoom) {
        this.bounds = LngLatBounds.convert(this.validateBounds(bounds));
        this.minzoom = minzoom || 0;
        this.maxzoom = maxzoom || 24;
    }
    validateBounds(bounds) {
        // make sure the bounds property contains valid longitude and latitudes
        if (!Array.isArray(bounds) || bounds.length !== 4)
            return [-180, -90, 180, 90];
        return [Math.max(-180, bounds[0]), Math.max(-90, bounds[1]), Math.min(180, bounds[2]), Math.min(90, bounds[3])];
    }
    contains(tileID) {
        const worldSize = Math.pow(2, tileID.z);
        const level = {
            minX: Math.floor(mercatorXfromLng(this.bounds.getWest()) * worldSize),
            minY: Math.floor(mercatorYfromLat(this.bounds.getNorth()) * worldSize),
            maxX: Math.ceil(mercatorXfromLng(this.bounds.getEast()) * worldSize),
            maxY: Math.ceil(mercatorYfromLat(this.bounds.getSouth()) * worldSize)
        };
        const hit = tileID.x >= level.minX && tileID.x < level.maxX && tileID.y >= level.minY && tileID.y < level.maxY;
        return hit;
    }
}
export default TileBounds;
//# sourceMappingURL=tile_bounds.js.map