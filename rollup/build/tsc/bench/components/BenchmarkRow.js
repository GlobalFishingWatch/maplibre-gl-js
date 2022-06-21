import { probabilitiesOfSuperiority } from '../lib/statistics';
import { BenchmarkStatistic } from './BenchmarkStatistic';
import { RegressionPlot } from './RegressionPlot';
import { StatisticsPlot } from './StatisticsPlot';
import { formatSample, versionColor } from './util';
import React from 'react';
export const BenchmarkRow = (props) => {
    const endedCount = props.versions.filter(version => version.status === 'ended').length;
    let main;
    let current;
    if (/main/.test(props.versions[0].name)) {
        [main, current] = props.versions;
    }
    else {
        [current, main] = props.versions;
    }
    let change;
    let pInferiority;
    if (endedCount === 2) {
        const delta = current.summary.trimmedMean - main.summary.trimmedMean;
        // Use "Cohen's d" (modified to used the trimmed mean/sd) to decide
        // how much to emphasize difference between means
        // https://en.wikipedia.org/wiki/Effect_size#Cohen.27s_d
        const pooledDeviation = Math.sqrt(((main.samples.length - 1) * Math.pow(main.summary.windsorizedDeviation, 2) +
            (current.samples.length - 1) * Math.pow(current.summary.windsorizedDeviation, 2)) /
            (main.samples.length + current.samples.length - 2));
        const d = delta / pooledDeviation;
        const { superior, inferior } = probabilitiesOfSuperiority(main.samples, current.samples);
        change = React.createElement("span", { className: d < 0.2 ? 'quiet' : d < 1.5 ? '' : 'strong' },
            "(",
            delta > 0 ? '+' : '',
            formatSample(delta),
            " ms / ",
            d.toFixed(1),
            " std devs )");
        const comparison = inferior > superior ? 'SLOWER' : 'faster';
        const probability = Math.max(inferior, superior);
        pInferiority = React.createElement("p", { className: `center ${probability > 0.90 ? 'strong' : 'quiet'}` },
            (probability * 100).toFixed(0),
            "% chance that a random ",
            React.createElement("svg", { width: 8, height: 8 },
                React.createElement("circle", { fill: versionColor(current.name), cx: 4, cy: 4, r: 4 })),
            " sample is",
            comparison,
            " than a random ",
            React.createElement("svg", { width: 8, height: 8 },
                React.createElement("circle", { fill: versionColor(main.name), cx: 4, cy: 4, r: 4 })),
            " sample.");
    }
    const renderStatistic = (title, statistic) => {
        return (React.createElement("tr", null,
            React.createElement("th", null, title),
            props.versions.map(version => React.createElement("td", { key: version.name },
                React.createElement(BenchmarkStatistic, { statistic: statistic, status: version.status, error: version.error, version: version })))));
    };
    const reload = () => {
        location.reload();
    };
    return (React.createElement("div", { className: "col12 clearfix space-bottom" },
        React.createElement("table", { className: "fixed space-bottom" },
            React.createElement("tbody", null,
                React.createElement("tr", null,
                    React.createElement("th", null,
                        React.createElement("h2", { className: "col4" },
                            React.createElement("a", { href: `#${props.name}`, onClick: reload }, props.name))),
                    props.versions.map(version => React.createElement("th", { style: { color: versionColor(version.name) }, key: version.name }, version.name))),
                props.location && React.createElement("tr", null,
                    React.createElement("th", null,
                        React.createElement("p", { style: { color: '#1287A8' } }, props.location.description)),
                    React.createElement("th", null,
                        React.createElement("p", { style: { color: '#1287A8' } },
                            "Zoom Level: ",
                            props.location.zoom)),
                    React.createElement("th", null,
                        React.createElement("p", { style: { color: '#1287A8' } },
                            "Lat: ",
                            props.location.center[1],
                            " Lng: ",
                            props.location.center[0]))),
                renderStatistic('(20% trimmed) Mean', (version) => React.createElement("p", null,
                    formatSample(version.summary.trimmedMean),
                    " ms",
                    current && version.name === current.name && change)),
                renderStatistic('(Windsorized) Deviation', (version) => React.createElement("p", null,
                    formatSample(version.summary.windsorizedDeviation),
                    " ms")),
                renderStatistic('R² Slope / Correlation', (version) => React.createElement("p", null,
                    formatSample(version.regression.slope),
                    " ms / ",
                    version.regression.correlation.toFixed(3),
                    " ",
                    version.regression.correlation < 0.9 ? '\u2620\uFE0F' :
                        version.regression.correlation < 0.99 ? '\u26A0\uFE0F' : '')),
                renderStatistic('Minimum', (version) => React.createElement("p", null,
                    formatSample(version.summary.min),
                    " ms")),
                pInferiority && React.createElement("tr", null,
                    React.createElement("td", { colSpan: 3 }, pInferiority)))),
        endedCount > 0 && React.createElement(StatisticsPlot, { versions: props.versions }),
        endedCount > 0 && React.createElement(RegressionPlot, { versions: props.versions })));
};
//# sourceMappingURL=BenchmarkRow.js.map