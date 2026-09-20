.PHONY: install synth check graph clean

## Install Node.js dependencies
install:
	flox activate -- npm install

## Synthesize the self-CI PAC artifacts into .tektonic/
synth:
	flox activate -- npm run synth

## Fail if the committed .tektonic/ output is stale, missing or orphaned
check:
	flox activate -- npm run check

## Print the self-CI task DAG (FORMAT=mermaid for a flowchart)
graph:
	flox activate -- npm run build
	flox activate -- node packages/tektonic/dist/cli/index.js graph examples/self-ci.ts --format $(or $(FORMAT),text)

## Remove compiled output
clean:
	flox activate -- npm run clean
