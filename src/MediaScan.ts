// Imports
import FileHound from 'filehound';
import {basename, normalize} from 'path';
import {uniq, difference, partition, cloneDeep} from 'lodash';
import PromiseLib from 'bluebird';

const videosExtension = require('video-extensions');
const nameParser = require('parse-torrent-title').parse;
import {EventEmitter} from 'events';

// local import
import {
    filterMoviesByProperties, filterTvSeriesByProperties
}
    from './filters/filterProperties';
import {defaultWhichCategoryFunction, promisifiedAccess} from './utils/utils_functions';

// Typescript types
import mediaScan from "./declaration";

/**
 * Class representing the MediaScan Library
 * @extends {EventEmitter}
 */
module.exports = class MediaScan extends EventEmitter {

    protected defaultPath: string; // Default path , if paths is empty
    protected parser: mediaScan.ParseFunction; // the parser to extract the useful data from name
    protected whichCategory: mediaScan.WhichCategoryFunction; // Function that tell us what is the category of the TPN
    protected paths: string[]; // all the paths that will be explored
    protected categoryForFile: Map<string, mediaScan.Category>; // the mapping between file and Category
    protected stores: mediaScan.MapSet<mediaScan.TPN | mediaScan.TPN_Extended>; // where I keep the result of Category
    // constants getter for external purposes (example create a custom whichCategory function)
    // workaround : const string enum aren't compiled correctly with Babel
    static readonly MOVIES_TYPE = 'MOVIES' as mediaScan.Category.MOVIES_TYPE;
    static readonly TV_SERIES_TYPE = 'TV_SERIES' as mediaScan.Category.TV_SERIES_TYPE;

    constructor({
                    defaultPath = process.cwd(),
                    paths = [],
                    allFilesWithCategory = new Map(),
                    movies = new Set(),
                    series = new Map(),
                }: mediaScan.DataParameters = {},
                {
                    parser = nameParser,
                    whichCategory = defaultWhichCategoryFunction,
                }: mediaScan.CustomFunctionsConfig = {}) {
        super();
        this.parser = parser;
        this.whichCategory = whichCategory;
        this.defaultPath = defaultPath;
        this.paths = paths;
        this.stores = new Map();
        // workaround : const string enum aren't compiled correctly with Babel
        this.stores.set(MediaScan.MOVIES_TYPE, movies);
        this.stores.set(MediaScan.TV_SERIES_TYPE, series);
        this.categoryForFile = allFilesWithCategory;
    }

    private addNewFiles(files: string[]): Promise<any> {
        return new PromiseLib((resolve, reject) => {
            try {
                // find the new files to be added
                const alreadyFoundFiles = [...this.categoryForFile.keys()];
                const newFiles = difference(files, alreadyFoundFiles);

                // temp var for new files before adding them to stores var
                const moviesSet = new Set();
                const tvSeriesSet = new Set();

                // get previous result of stores var
                let newMovies = this.allMovies;
                const newTvSeries = this.allTvSeries;

                // process each file
                for (const file of newFiles) {
                    // get data from nameParser lib
                    // what we need is only the basename, not the full path
                    const jsonFile = this.parser(basename(file));
                    // extend this object in order to be used by this library
                    Object.assign(jsonFile, {filePath: file});
                    // find out which type of this file
                    // if it has not undefined properties (season and episode) => TV_SERIES , otherwise MOVIE
                    const fileCategory = this.whichCategory(jsonFile);
                    // add it in found files
                    this.categoryForFile.set(file, fileCategory);
                    // also in temp var
                    // workaround : const string enum aren't compiled correctly with Babel
                    if (fileCategory !== MediaScan.TV_SERIES_TYPE) {
                        moviesSet.add(jsonFile);
                    } else {
                        tvSeriesSet.add(jsonFile);
                    }
                }

                // add the movies into newMovies
                newMovies = new Set([...newMovies, ...moviesSet]);

                // add the tv series into newTvSeries
                // First step : find all the series not in newTvSeries and add them to newTvSeries
                difference(
                    uniq([...tvSeriesSet].map(tvSeries => tvSeries.title)),
                    ...newTvSeries.keys(),
                ).forEach((tvSeriesToInsert) => {
                    newTvSeries.set(tvSeriesToInsert, new Set());
                });

                // Second step : add the new files into the correct tvSeries Set
                uniq([...tvSeriesSet].map(tvSeries => tvSeries.title))
                    .forEach((tvSerie) => {
                        // get the current set for this tvSerie
                        const currentTvSerie: Set<mediaScan.TPN_Extended> = newTvSeries.get(tvSerie);

                        // find all the episodes in the new one for this serie
                        const episodes = [...tvSeriesSet]
                            .filter(episode => episode.title === tvSerie);

                        // add them and updates newTvSeries
                        newTvSeries.set(
                            tvSerie,
                            new Set([...currentTvSerie, ...episodes]),
                        );
                    });

                // updates the stores var
                // workaround : const string enum aren't compiled correctly with Babel
                this.stores.set(MediaScan.MOVIES_TYPE, newMovies);
                this.stores.set(MediaScan.TV_SERIES_TYPE, newTvSeries);
                resolve();
            } catch (err) {
                reject(err);
            }
        }).bind(this);
    }

    static listVideosExtension(): string[] {
        return videosExtension;
    }

    addNewPath(...paths: string[]): Promise<any> {
        // the user should provide us at lest a path
        if (paths.length === 0) {
            this.emit('missing_parameter', {
                functionName: 'addNewPath',
            });
            return Promise.reject(new Error('Missing parameter'));
        }

        return new PromiseLib(((resolve, reject) => {
            PromiseLib.map(paths, path => promisifiedAccess(path)).then(() => {
                // keep only unique paths
                // use normalize for cross platform's code
                this.paths = uniq([...this.paths, ...paths.map(normalize)]);
                this.emit('addNewPath', {paths: this.paths});
                resolve('All paths were added!');
            }).catch((e) => {
                this.emit('error_in_function', {
                    functionName: 'addNewPath',
                    error: e.message,
                });
                reject(e);
            });
        })).bind(this);
    }

    hasPathsProvidedByUser(): boolean {
        return this.paths.length !== 0;
    }

    scan(): Promise<any> {
        return new PromiseLib((resolve, reject) => {
            FileHound
                .create()
                .paths((this.paths.length === 0) ? this.defaultPath : this.paths)
                .ext(videosExtension)
                .find()
                .then(
                    files => PromiseLib.join(this.addNewFiles(files), () => {
                        return Promise.resolve(files)
                    })
                )
                .then((files) => {
                    this.emit('scan', {files: files});
                    resolve('Scanning completed');
                })
                .catch((err) => {
                    this.emit('error_in_function', {
                        functionName: 'scan',
                        error: err.message,
                    });
                    reject(err);
                });

        }).bind(this);
    }

    removeOldFiles(...files: string[]): Promise<any> {
        return new PromiseLib((resolve, reject) => {
            try {
                // get the data to handle this case
                // in the first group, we got all the tv series files and in the second, the movies
                // workaround : const string enum aren't compiled correctly with Babel
                const processData = partition(files, file =>
                    this.categoryForFile.get(file) === MediaScan.TV_SERIES_TYPE);
                // for movies, just an easy removal
                // workaround : const string enum aren't compiled correctly with Babel
                this.stores.set(
                    MediaScan.MOVIES_TYPE,
                    new Set([...this.allMovies]
                        .filter(movie => !(processData[1].includes(movie.filePath)))),
                );

                // for the tv-series, a bit more complicated
                // first step : find the unique tv series of these files
                const tvSeriesShows = uniq(processData[0]
                    .map(file => this.parser(basename(file)).title));
                // second step : foreach each series in tvSeriesShows
                const newTvSeriesMap = this.allTvSeries;

                for (const series of tvSeriesShows) {
                    // get the set for this serie
                    const filteredSet = new Set([...newTvSeriesMap.get(series)]
                        .filter(episode =>
                            !(processData[0].includes(episode.filePath))));
                    // if the filtered set is empty => no more episodes for this series
                    if (filteredSet.size === 0) {
                        newTvSeriesMap.delete(series);
                    } else newTvSeriesMap.set(series, filteredSet);
                }

                // save the updated map
                // workaround : const string enum aren't compiled correctly with Babel
                this.stores.set(MediaScan.TV_SERIES_TYPE, newTvSeriesMap);

                // remove the mapping
                files.forEach((file) => {
                    this.categoryForFile.delete(file);
                });
                this.emit('removeOldFiles', {files});
                resolve({
                    message: 'The files have been deleted from the library',
                    files,
                });
            } catch (err) {
                this.emit('error_in_function', {
                    functionName: 'removeOldFiles',
                    error: err.message,
                });
                reject(err);
            }
        }).bind(this);
    }

    get allMovies(): Set<mediaScan.TPN_Extended> {
        // workaround : const string enum aren't compiled correctly with Babel
        return cloneDeep(this.stores.get(MediaScan.MOVIES_TYPE));
    }

    get allTvSeries(): Map<string, Set<mediaScan.TPN_Extended>> {
        // workaround : const string enum aren't compiled correctly with Babel
        return cloneDeep(this.stores.get(MediaScan.TV_SERIES_TYPE));
    }

    get allFilesWithCategory(): Map<string, string> {
        return cloneDeep(this.categoryForFile);
    }

    toJSON(): string {
        const tvSeries = this.allTvSeries;
        return `{
    "paths":${JSON.stringify([...this.paths])},
    "allFilesWithCategory":${JSON.stringify([...this.allFilesWithCategory])},
    "movies":${JSON.stringify([...this.allMovies])},
    "series":${JSON.stringify([...tvSeries].map(serie =>
            // serie[0] contains the title and [1] the wrong JSON ; let fix it
            [serie[0], [...tvSeries.get(serie[0])]]))}
    }`.trim();
    }

    static createFromJSON(json: mediaScan.LibAsJson, customConfig?: mediaScan.CustomFunctionsConfig): MediaScan {
        let config: mediaScan.DataParameters = {};
        // transform the param
        /* istanbul ignore else */
        if (json.allFilesWithCategory) {
            config.allFilesWithCategory = new Map(json.allFilesWithCategory);
        }
        /* istanbul ignore else */
        if (json.movies) {
            config.movies = new Set(json.movies);
        }
        /* istanbul ignore else */
        if (json.series) {
            let createdMap = new Map();
            for (let [series_title, set_series] of json.series) {
                createdMap.set(series_title, new Set(set_series));
            }
            config.series = createdMap;
        }
        /* istanbul ignore else */
        if (json.paths) {
            config.paths = json.paths;
        }
        return new MediaScan(config, customConfig);
    }

    filterMovies(searchParameters: mediaScan.SearchParameters = {}) {
        // apply params based on types
        return filterMoviesByProperties(searchParameters, this.allMovies);
    }

    filterTvSeries(searchParameters: mediaScan.SearchParameters = {}) {
        return filterTvSeriesByProperties(searchParameters, this.allTvSeries);
    }
};
