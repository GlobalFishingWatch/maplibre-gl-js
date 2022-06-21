import Benchmark from '../lib/benchmark';
import createMap from '../lib/create_map';
const width = 1024;
const height = 768;
export default class Paint extends Benchmark {
    constructor(style, locations) {
        super();
        this.style = style;
        this.locations = locations;
    }
    setup() {
        return Promise.all(this.locations.map(location => {
            return createMap({
                zoom: location.zoom,
                width,
                height,
                center: location.center,
                style: this.style,
                idle: true
            });
        }))
            .then(maps => {
            this.maps = maps;
        })
            .catch(error => {
            console.error(error);
        });
    }
    bench() {
        for (const map of this.maps) {
            const showCollisionBoxes = false;
            const fadeDuration = 300;
            const crossSourceCollisions = true;
            const forceFullPlacement = true;
            map.style._updatePlacement(map.transform, showCollisionBoxes, fadeDuration, crossSourceCollisions, forceFullPlacement);
        }
    }
    teardown() {
        for (const map of this.maps) {
            map.remove();
        }
    }
}
//# sourceMappingURL=placement.js.map