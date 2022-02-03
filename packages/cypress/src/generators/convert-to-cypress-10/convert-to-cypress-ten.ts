import {
  formatFiles,
  installPackagesTask,
  Tree,
  updateJson,
} from '@nrwl/devkit';
import { forEachExecutorOptions } from '@nrwl/workspace/src/utilities/executor-options-utils';
import { CypressExecutorOptions } from '../../executors/cypress/cypress.impl';
import { cypressVersion } from '../../utils/versions';
import { updateProject } from './conversion.util';
import { CypressConvertOptions } from './schema';

function normalizeOptions(
  options: CypressConvertOptions
): CypressConvertOptions {
  // ignore project as that will always be the default project if not provided
  if (options.all) {
    return {
      all: true,
      project: undefined,
      targets: options.targets,
    };
  }

  if (!options.project && !options.all) {
    throw new Error(
      'Missing project to convert. Specify --project OR --all to convert all e2e projects'
    );
  }

  return options;
}

export async function convertCypressProject(
  tree: Tree,
  options: CypressConvertOptions
) {
  options = normalizeOptions(options);

  if (options.all) {
    forEachExecutorOptions(
      tree,
      '@nrwl/cypress:cypress',
      (currentValue: CypressExecutorOptions, project) => {
        updateProject(tree, {
          ...options,
          project,
        });
      }
    );
  } else {
    updateProject(tree, options);
  }

  // TODO(caleb): only do this if a project was updated
  updateJson(tree, 'package.json', (json) => {
    json.devDependencies['cypress'] = TMP_CYPRESS_VERSION;
    return json;
  });

  await formatFiles(tree);
  return () => {
    installPackagesTask(tree);
  };
}

export default convertCypressProject;
