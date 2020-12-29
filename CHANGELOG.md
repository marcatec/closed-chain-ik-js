# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2020-12-28

### Added

- `findRoots` function for finding unique connected hierarchy roots from a set of frames.
- `useSVD` option for Solvers.

### Fixed

- Joint rest pose not being applied correctly resulting in the solver often not converging.

### Changed

- Closure links are no longer added to the Joint children array.
- All connected roots no longer have to be manually added to the IKRootsHelper or Solvers.

## [0.0.1] - 2020-10-17

Initial release