import React from 'react';
export const BenchmarkStatistic = (props) => {
    switch (props.status) {
        case 'waiting':
            return React.createElement("p", { className: "quiet" });
        case 'running':
            return React.createElement("p", null, "Running...");
        case 'error':
        case 'errored':
            return React.createElement("p", null, props.error.message);
        default:
            return props.statistic(props.version);
    }
};
//# sourceMappingURL=BenchmarkStatistic.js.map