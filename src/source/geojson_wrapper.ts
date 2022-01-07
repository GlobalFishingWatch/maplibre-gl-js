import Point from '../util/point';

import mvt from '@mapbox/vector-tile';
import type {VectorTileFeature, VectorTileLayer, VectorTile} from '@mapbox/vector-tile';
const toGeoJSON = mvt.VectorTileFeature.prototype.toGeoJSON;
import EXTENT from '../data/extent';

// The feature type used by geojson-vt and supercluster. Should be extracted to
// global type and used in module definitions for those two modules.
export type Feature = {
  type: 1;
  id: any;
  tags: {[_: string]: string | number | boolean};
  geometry: Array<[number, number]>;
} | {
  type: 2 | 3;
  id: any;
  tags: {[_: string]: string | number | boolean};
  geometry: Array<Array<[number, number]>>;
};

class FeatureWrapper implements VectorTileFeature {
    _feature: Feature;

    extent: number;
    type: 1 | 2 | 3;
    id: number;
    properties: {[_: string]: string | number | boolean};

    constructor(feature: Feature, extent = EXTENT) {
        this._feature = feature;

        this.extent = extent;
        this.type = feature.type;
        this.properties = feature.tags;

        // If the feature has a top-level `id` property, copy it over, but only
        // if it can be coerced to an integer, because this wrapper is used for
        // serializing geojson feature data into vector tile PBF data, and the
        // vector tile spec only supports integer values for feature ids --
        // allowing non-integer values here results in a non-compliant PBF
        // that causes an exception when it is parsed with vector-tile-js
        if ('id' in feature && !isNaN(feature.id)) {
            this.id = parseInt(feature.id, 10);
        }
    }

    loadGeometry() {
        if (this._feature.type === 1) {
            const geometry = [];
            for (const point of this._feature.geometry) {
                geometry.push([new Point(point[0], point[1])]);
            }
            return geometry;
        } else {
            const geometry = [];
            for (const ring of this._feature.geometry) {
                const newRing = [];
                for (const point of ring) {
                    newRing.push(new Point(point[0], point[1]));
                }
                geometry.push(newRing);
            }
            return geometry;
        }
    }

    toGeoJSON(x: number, y: number, z: number) {
        return toGeoJSON.call(this, x, y, z);
    }
}

export type GeojsonWrapperOptions = {
    name?: string;
    extent?: number;
};

class GeoJSONWrapper implements VectorTile, VectorTileLayer {
    layers: {[_: string]: VectorTileLayer};
    name: string;
    extent: number;
    length: number;
    _features: Array<Feature>;

    constructor(features: Array<Feature>, options?: GeojsonWrapperOptions) {
        const {name = '_geojsonTileLayer', extent = EXTENT} = options || {};
        this.layers = {[name]: this};
        this.name = name;
        this.extent = extent;
        this.length = features.length;
        this._features = features;
    }

    feature(i: number): VectorTileFeature {
        return new FeatureWrapper(this._features[i], this.extent);
    }
}

export default GeoJSONWrapper;
