.PHONY: install synth synth-ci clean

## Install Node.js dependencies
install:
	flox activate -- npm install

## Synthesize the example PAC artifacts (PipelineRun templates + tasks/) into .tekton/
synth:
	flox activate -- npm run synth

## Synthesize the self-CI PAC artifacts into .tektonic/
synth-ci:
	flox activate -- npx ts-node examples/self-ci.ts

## Remove compiled output
clean:
	rm -rf synth-output/ dist/
