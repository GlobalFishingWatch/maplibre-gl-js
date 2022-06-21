import { extend } from './util';
/**
 * This is a private namespace for utility functions that will get automatically stripped
 * out in production builds.
 *
 * @private
 */
export const Debug = {
    extend(dest, ...sources) {
        return extend(dest, ...sources);
    },
    run(fn) {
        fn();
    },
    logToElement(message, overwrite = false, id = 'log') {
        const el = window.document.getElementById(id);
        if (el) {
            if (overwrite)
                el.innerHTML = '';
            el.innerHTML += `<br>${message}`;
        }
    }
};
//# sourceMappingURL=debug.js.map