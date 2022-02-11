import {
  joinPathFragments,
  logger,
  ProjectConfiguration,
  readJson,
  readProjectConfiguration,
  stripIndents,
  Tree,
  updateProjectConfiguration,
  visitNotIgnoredFiles,
} from '@nrwl/devkit';
import { tsquery } from '@phenomnomnominal/tsquery';
import { basename, dirname, extname } from 'path';
import { StringLiteral } from 'typescript';
import { inspect } from 'util';
import { installedCypressVersion } from '../../utils/cypress-version';
import { CypressConvertOptions } from './schema';

const validFilesEndingsToUpdate = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
];

export function updateProject(tree: Tree, options: CypressConvertOptions) {
  const projectConfig = readProjectConfiguration(tree, options.project);
  for (const target of options.targets) {
    const { shouldUpgrade, cypressConfigPathTs, cypressConfigPathJson } =
      verifyProjectForUpgrade(tree, projectConfig, target);

    if (!shouldUpgrade) {
      continue;
    }

    const cypressConfigs = createNewCypressConfig(
      tree,
      projectConfig,
      cypressConfigPathJson
    );

    updateProjectPaths(tree, projectConfig, cypressConfigs);
    writeNewConfig(tree, cypressConfigPathTs, cypressConfigs);

    tree.delete(cypressConfigPathJson);

    projectConfig.targets[target].options = {
      ...projectConfig.targets[target].options,
      cypressConfig: cypressConfigPathTs,
      testingType: 'e2e',
    };

    updateProjectConfiguration(tree, options.project, projectConfig);
  }
}

/**
 * validate that the provided project target is using the cypress executor
 * and there is a cypress.json file and NOT a cypress.config.ts file
 */
export function verifyProjectForUpgrade(
  tree: Tree,
  projectConfig: ProjectConfiguration,
  target: string
): {
  shouldUpgrade: boolean;
  cypressConfigPathJson: string;
  cypressConfigPathTs: string;
} {
  if (!projectConfig.targets?.[target]) {
    return {
      shouldUpgrade: false,
      cypressConfigPathJson: undefined,
      cypressConfigPathTs: undefined,
    };
  }
  // make sure we have a cypress executor and a cypress.json file and NOT a cypress.config.ts file
  const cypressConfigPathJson =
    projectConfig.targets[target]?.options?.cypressConfig ||
    joinPathFragments(projectConfig.root, 'cypress.json');

  const cypressConfigPathTs = joinPathFragments(
    projectConfig.root,
    'cypress.config.ts'
  );

  let shouldUpgrade = false;

  if (installedCypressVersion() < 8) {
    logger.warn(
      stripIndents`
Please upgrade to Cypress version 8 before trying to convert the project to Cypress version 10. 
https://docs.cypress.io/guides/references/migration-guide#Migrating-to-Cypress-8-0`
    );
    return {
      cypressConfigPathJson,
      cypressConfigPathTs,
      shouldUpgrade,
    };
  }

  if (projectConfig.targets[target].executor === '@nrwl/cypress:cypress') {
    if (
      tree.exists(cypressConfigPathJson) &&
      !tree.exists(cypressConfigPathTs)
    ) {
      shouldUpgrade = true;
    }
  }

  return {
    cypressConfigPathJson,
    cypressConfigPathTs,
    shouldUpgrade,
  };
}

/**
 * update the existing cypress.json config to the new cypress.config.ts structure.
 * return both the old and new configs
 */
export function createNewCypressConfig(
  tree: Tree,
  projectConfig: ProjectConfiguration,
  cypressConfigPathJson: string
): {
  cypressConfigTs: Record<string, any>;
  cypressConfigJson: Record<string, any>;
} {
  const cypressConfigJson = readJson(tree, cypressConfigPathJson);

  const {
    baseUrl = null,
    modifyObstructiveCode = null, // cypress complains about this property do we still need it?
    integrationFolder = 'src/e2e',
    supportFile = 'src/support/e2e.ts',
    ...restOfConfig
  } = cypressConfigJson;

  const cypressConfigTs = baseUrl
    ? {
        baseUrl,
      }
    : {};

  cypressConfigTs['e2e'] = {
    ...restOfConfig,
    specPattern: 'src/e2e/**/*.cy.{js,jsx,ts,tsx}',
    // if supportFile is defined (can be false if not using it) and in the default location,
    // then use the new default location.
    // otherwise we will use the existing folder location/falsey value
    supportFile:
      supportFile &&
      tree.exists(
        joinPathFragments(projectConfig.sourceRoot, 'support', 'index.ts')
      )
        ? 'src/support/e2e.ts'
        : supportFile,
    integrationFolder: tree.exists(
      joinPathFragments(projectConfig.sourceRoot, 'integration')
    )
      ? 'src/e2e'
      : integrationFolder,
  };

  return { cypressConfigTs, cypressConfigJson };
}

export function updateProjectPaths(
  tree: Tree,
  projectConfig: ProjectConfiguration,
  {
    cypressConfigTs,
    cypressConfigJson,
  }: {
    cypressConfigTs: Record<string, any>;
    cypressConfigJson: Record<string, any>;
  }
) {
  const { integrationFolder, supportFile } = cypressConfigTs['e2e'];

  const oldIntegrationFolder = joinPathFragments(
    projectConfig.root,
    cypressConfigJson.integrationFolder
  );
  const newIntegrationFolder = joinPathFragments(
    projectConfig.root,
    integrationFolder
  );

  let newSupportFile: string;
  let oldSupportFile: string;
  let oldImportLeafPath: string;
  let newImportLeafPath: string;
  let shouldUpdateSupportFileImports = false;
  // supportFile can be falsey or a string path to the file
  if (cypressConfigJson.supportFile) {
    shouldUpdateSupportFileImports = true;
    oldSupportFile = joinPathFragments(
      projectConfig.root,
      cypressConfigJson.supportFile
    );

    newSupportFile = joinPathFragments(projectConfig.root, supportFile);
    tree.rename(oldSupportFile, newSupportFile);
  } else {
    shouldUpdateSupportFileImports = false;
    newSupportFile = supportFile;
    // rename the default support file even if not in use to keep the system in sync with cypress v10
    // rename the default support/index.ts file even if it wasn't being used in the config.
    const defaultSupportFile = joinPathFragments(
      projectConfig.sourceRoot,
      'support',
      'index.ts'
    );

    if (tree.exists(defaultSupportFile)) {
      const newSupportDefaultPath = joinPathFragments(
        projectConfig.sourceRoot,
        'support',
        'e2e.ts'
      );
      // TODO(caleb): should this be logged?
      logger.info(stripIndents`
NOTE: The default support file was found even though it's not being used. Renaming to keep in sync with Cypress v10.
${defaultSupportFile} => ${newSupportDefaultPath}    
    `);
      tree.rename(defaultSupportFile, newSupportDefaultPath);
    }
  }

  if (shouldUpdateSupportFileImports) {
    // take ../support => ../support/e2e.ts
    // first take apps/app-e2e/support/index.ts => support (this cant have a / in it. must grab the leaf)
    // but if leaf is index.ts then grab the parent directory
    // then take apps/app-e2e/support/e2e.ts => support/e2e

    // "e2e"
    const newRelativeImportPath = basename(
      newSupportFile,
      extname(newSupportFile)
    );
    // "support"
    const newImportParentDirectory = basename(dirname(newSupportFile));
    // "support/e2e"
    newImportLeafPath = joinPathFragments(
      newImportParentDirectory,
      newRelativeImportPath
    );
    // "index"
    const oldRelativeImportPath = basename(
      oldSupportFile,
      extname(oldSupportFile)
    );
    // "support"
    const oldImportParentDirectory = basename(dirname(oldSupportFile));
    // don't import from 'support/index' it's just 'support'
    oldImportLeafPath =
      oldRelativeImportPath === 'index'
        ? oldImportParentDirectory
        : oldRelativeImportPath;
  }

  // tree.rename doesn't work on directories must update each file within
  // the directory to the new directory
  visitNotIgnoredFiles(tree, projectConfig.sourceRoot, (path) => {
    if (!path.includes(oldIntegrationFolder)) {
      return;
    }
    const fileName = basename(path);
    let newPath = path.replace(oldIntegrationFolder, newIntegrationFolder);

    if (fileName.includes('.spec.')) {
      newPath = newPath.replace('.spec.', '.cy.');
    }
    // renaming with no same path is a noop
    tree.rename(path, newPath);
    // if they weren't use the supportFile then there is no need to update the imports.
    if (
      shouldUpdateSupportFileImports &&
      validFilesEndingsToUpdate.some((e) => path.endsWith(e))
    ) {
      updateImports(tree, newPath, oldImportLeafPath, newImportLeafPath);
    }
  });

  if (tree.children(oldIntegrationFolder).length === 0) {
    tree.delete(oldIntegrationFolder);
  }
}

export function updateImports(
  tree: Tree,
  filePath: string,
  oldImportPath: string,
  newImportPath: string
) {
  const endOfImportSelector = `StringLiteral[value=/${oldImportPath}$/]`;
  const fileContent = tree.read(filePath, 'utf-8');
  const newContent = tsquery.replace(
    fileContent,
    endOfImportSelector,
    (node: StringLiteral) => {
      return `'${node.text.replace(oldImportPath, newImportPath)}'`;
    }
  );
  tree.write(filePath, newContent);
}

function writeNewConfig(
  tree: Tree,
  cypressConfigPathTs: string,
  cypressConfigs: {
    cypressConfigTs: Record<string, any>;
    cypressConfigJson: Record<string, any>;
  }
) {
  // remove deprecated configs options
  const {
    pluginsFile = false,
    integrationFolder = '',
    ...restOfConfig
  } = cypressConfigs.cypressConfigTs.e2e;
  const pluginImport = pluginsFile
    ? `import setupNodeEvents from '${pluginsFile}';`
    : '';

  // strip off the start { } from the start/end of the object
  const convertedConfig = inspect(restOfConfig).trim().slice(1, -1).trim();

  tree.write(
    cypressConfigPathTs,
    String.raw`
import { defineConfig } from 'cypress'
import { nxE2EPreset } from '@nrwl/cypress/plugins/cypress-preset';
${pluginImport}

export default defineConfig({
  e2e: {
    ...nxE2EPreset(__dirname),
    ${convertedConfig},
    ${pluginsFile ? 'setupNodeEvents' : ''}
  }
})
`
  );
}
