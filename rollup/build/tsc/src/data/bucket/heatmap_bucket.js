import CircleBucket from './circle_bucket';
import { register } from '../../util/web_worker_transfer';
class HeatmapBucket extends CircleBucket {
}
register('HeatmapBucket', HeatmapBucket, { omit: ['layers'] });
export default HeatmapBucket;
//# sourceMappingURL=heatmap_bucket.js.map