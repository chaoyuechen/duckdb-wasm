import * as arrow from 'apache-arrow';
import * as rd from '@duckdb/react-duckdb';
import * as rdt from '@duckdb/react-duckdb-table';
import React from 'react';
import { useDrag } from 'react-dnd';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import styles from './stock_pivot_table.module.css';
import { StockDataSource } from './stock_data';
import icon_pivot from '../../static/svg/icons/pivot.svg';

const INSERT_INTERVAL = 0.2;
const INSERT_BATCH_SIZE = 100;
const ROWS_TO_KEEP = 4000;
const SECONDS_TO_KEEP = (ROWS_TO_KEEP / INSERT_BATCH_SIZE) * INSERT_INTERVAL;

interface DraggableProps {
    className?: string;
    type: string;
    id: number;
    children?: React.ReactElement | React.ReactElement[] | string;
}

const Draggable = (props: DraggableProps) => {
    const [state, dragRef] = useDrag(
        () => ({
            type: props.type,
            item: () => ({
                id: props.id,
                text: props.children,
            }),
            collect: monitor => ({
                isDragging: monitor.isDragging(),
            }),
        }),
        [],
    );
    return (
        <div ref={dragRef} className={props.className} style={{ opacity: state.isDragging ? 0.0 : 1.0 }}>
            {props.children}
        </div>
    );
};

interface ExplorerProps {
    className?: string;
}

interface PivotConfig {
    groupRowsBy: rdt.PivotRowGrouping[];
    groupColumnsBy: number[];
    aggregates: rdt.PivotAggregate[];
}

export const StockPivotExplorer: React.FC<ExplorerProps> = (props: ExplorerProps) => {
    const conn = rd.useDuckDBConnection()!;
    const table = rd.useTableSchema();
    const [pivot, _setPivot] = React.useState<PivotConfig>({
        groupRowsBy: [
            {
                expression: 'name',
                alias: 'name',
            },
            {
                expression: `date_trunc('second', last_update)`,
                alias: 'timestamp',
            },
        ],
        groupColumnsBy: [1],
        aggregates: [
            {
                expression: 'ask',
                func: rdt.PivotAggregationFunction.SUM,
                alias: 'ask',
            },
            {
                expression: 'bid',
                func: rdt.PivotAggregationFunction.SUM,
                alias: 'bid',
            },
        ],
    });

    return (
        <div className={styles.pivot_container}>
            <div className={styles.pivot_icon_container}>
                <svg className={styles.pivot_icon} width="24px" height="24px">
                    <use xlinkHref={`${icon_pivot}#sym`} />
                </svg>
            </div>
            <div className={styles.table_columns}>
                <div className={styles.label_top}>Table</div>
                {table?.columnNames.map((n, i) => (
                    <Draggable key={i} id={i} className={styles.table_column} type="table_column">
                        {n}
                    </Draggable>
                ))}
            </div>
            <div className={styles.pivot_columns}>
                <div className={styles.label_top}>Column Groups</div>
                {pivot.groupColumnsBy.map((n, i) => (
                    <Draggable key={i} id={i} className={styles.pivot_column} type="pivot_column">
                        {table?.columnNames[n]}
                    </Draggable>
                ))}
            </div>
            <div className={styles.pivot_rows}>
                <div className={styles.label_left}>Row Groups</div>
                {pivot.groupRowsBy.map((n, i) => (
                    <Draggable key={i} id={i} className={styles.pivot_row} type="pivot_row">
                        {n.alias}
                    </Draggable>
                ))}
            </div>
            <div className={styles.pivot_values}>
                <div className={styles.label_left}>Values</div>
                {pivot.aggregates.map((n, i) => (
                    <Draggable key={i} id={i} className={styles.pivot_aggregate} type="pivot_aggregate">
                        {n.alias || undefined}
                    </Draggable>
                ))}
            </div>
            <div className={styles.pivot_body}>
                {pivot.groupColumnsBy.length == 0 && pivot.groupRowsBy.length == 0 ? (
                    <rdt.WiredTableViewer
                        connection={conn}
                        ordering={[
                            {
                                columnIndex: 0,
                            },
                            {
                                columnIndex: 2,
                                descending: true,
                            },
                        ]}
                    />
                ) : (
                    <rdt.PivotTableProvider
                        name="pivot"
                        connection={conn}
                        table={table}
                        groupRowsBy={pivot.groupRowsBy}
                        groupColumnsBy={pivot.groupColumnsBy}
                        aggregates={pivot.aggregates}
                    >
                        <rdt.WiredTableViewer connection={conn} />
                    </rdt.PivotTableProvider>
                )}
            </div>
        </div>
    );
};

interface DemoProps {
    className?: string;
}

interface State {
    schemaEpoch: number | null;
    dataEpoch: number | null;
}

export const StockPivotTableDemo: React.FC<DemoProps> = (props: DemoProps) => {
    const conn = rd.useDuckDBConnection();
    const connDialer = rd.useDuckDBConnectionDialer();
    const [setupDone, setSetupDone] = React.useState(false);
    const [state, setState] = React.useState<State>({
        schemaEpoch: 0,
        dataEpoch: 0,
    });
    const stockData = React.useRef(new StockDataSource());

    // Create connection if needed
    React.useEffect(() => {
        if (conn == null) {
            connDialer();
        }
    }, [conn]);

    // Detect unmount
    const isMounted = React.useRef(true);
    React.useEffect(() => {
        return () => void (isMounted.current = false);
    }, []);

    // Setup the table
    React.useEffect(() => {
        if (!conn) return;
        if (setupDone) return;
        const setup = async () => {
            await conn.query('DROP TABLE IF EXISTS stock_pivot_table');
            await conn.query(`
                CREATE TABLE stock_pivot_table (
                    name VARCHAR NOT NULL,
                    client VARCHAR NOT NULL,
                    last_update TIMESTAMP NOT NULL,
                    change DOUBLE NOT NULL,
                    bid DOUBLE NOT NULL,
                    ask DOUBLE NOT NULL,
                    volume DOUBLE NOT NULL
                )
            `);
            setSetupDone(true);
        };
        setup();
    }, [conn]);

    // Prepare the inserter
    const inserter = React.useCallback(async () => {
        if (!conn) return;
        if (!setupDone) return;
        if (!isMounted.current) return;

        // Insert the next batch
        const table = new arrow.Table([stockData.current.genBatch(INSERT_BATCH_SIZE)]);
        await conn.insertArrowTable(table, {
            name: 'stock_pivot_table',
            create: false,
        });
        await conn.query(`
            DELETE FROM stock_pivot_table
            WHERE last_update < date_trunc('second', now() - INTERVAL ${SECONDS_TO_KEEP} SECOND)
        `);

        // Schedule again
        if (isMounted.current) {
            setState(s => ({
                schemaEpoch: s.schemaEpoch,
                dataEpoch: (s.dataEpoch || 0) + 1,
            }));
            setTimeout(() => inserter(), INSERT_INTERVAL * 1000);
        }
    }, [conn, setupDone]);

    // Kick the first insert
    React.useEffect(() => {
        if (!conn) return;
        if (!setupDone) return;
        setTimeout(() => inserter(), 0);
    }, [conn, setupDone]);

    if (conn == null || !setupDone) {
        return (
            <div className={styles.table_page}>
                <div className={styles.grid_container} />
            </div>
        );
    }
    return (
        <DndProvider backend={HTML5Backend}>
            <div className={styles.table_page}>
                <rd.TABLE_SCHEMA_EPOCH.Provider value={state.schemaEpoch}>
                    <rd.TABLE_DATA_EPOCH.Provider value={state.dataEpoch}>
                        <rdt.PIVOT_COLUMNS_EPOCH.Provider value={0}>
                            <rd.DuckDBTableSchemaProvider name="stock_pivot_table">
                                <StockPivotExplorer />
                            </rd.DuckDBTableSchemaProvider>
                        </rdt.PIVOT_COLUMNS_EPOCH.Provider>
                    </rd.TABLE_DATA_EPOCH.Provider>
                </rd.TABLE_SCHEMA_EPOCH.Provider>
            </div>
        </DndProvider>
    );
};
