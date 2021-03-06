const path = require('path');
const { findIndex, reduce, toString } = require('lodash');
const readDirP = require('readdirp-walk');
const { parseMarkdown } = require('../tools/challenge-md-parser');
const { parseMD } = require('../tools/challenge-md-parser/mdx');
const fs = require('fs');
const util = require('util');
/* eslint-disable max-len */
const {
  mergeChallenges,
  translateCommentsInChallenge
} = require('../tools/challenge-md-parser/translation-parser/translation-parser');
/* eslint-enable max-len*/

const { isAuditedCert } = require('../utils/is-audited');
const { dasherize, nameify } = require('../utils/slugs');
const { createPoly } = require('../utils/polyvinyl');
const { blockNameify } = require('../utils/block-nameify');
const { supportedLangs } = require('./utils');
const { helpCategoryMap } = require('../client/utils/challengeTypes');

const access = util.promisify(fs.access);

const challengesDir = path.resolve(__dirname, './challenges');
const metaDir = path.resolve(challengesDir, '_meta');
exports.challengesDir = challengesDir;
exports.metaDir = metaDir;

const COMMENT_TRANSLATIONS = createCommentMap(
  path.resolve(__dirname, './dictionaries')
);

function getTranslatableComments(dictionariesDir) {
  const { COMMENTS_TO_TRANSLATE } = require(path.resolve(
    dictionariesDir,
    'english',
    'comments'
  ));
  return COMMENTS_TO_TRANSLATE.map(({ text }) => text);
}

exports.getTranslatableComments = getTranslatableComments;

function createCommentMap(dictionariesDir) {
  // get all the languages for which there are dictionaries.
  const languages = fs
    .readdirSync(dictionariesDir)
    .filter(x => x !== 'english');

  // get all their dictionaries
  const dictionaries = languages.reduce(
    (acc, lang) => ({
      ...acc,
      [lang]: require(path.resolve(dictionariesDir, lang, 'comments'))
    }),
    {}
  );

  // get the english dicts
  const {
    COMMENTS_TO_TRANSLATE,
    COMMENTS_TO_NOT_TRANSLATE
  } = require(path.resolve(dictionariesDir, 'english', 'comments'));

  // map from english comment text to translations
  const translatedCommentMap = COMMENTS_TO_TRANSLATE.reduce(
    (acc, { id, text }) => {
      return {
        ...acc,
        [text]: getTranslationEntry(dictionaries, { engId: id, text })
      };
    },
    {}
  );

  // map from english comment text to itself
  const untranslatableCommentMap = COMMENTS_TO_NOT_TRANSLATE.reduce(
    (acc, { text }) => {
      const englishEntry = languages.reduce(
        (acc, lang) => ({
          ...acc,
          [lang]: text
        }),
        {}
      );
      return {
        ...acc,
        [text]: englishEntry
      };
    },
    {}
  );

  return { ...translatedCommentMap, ...untranslatableCommentMap };
}

exports.createCommentMap = createCommentMap;

function getTranslationEntry(dicts, { engId, text }) {
  return Object.keys(dicts).reduce((acc, lang) => {
    const entry = dicts[lang].find(({ id }) => engId === id);
    if (entry) {
      return { ...acc, [lang]: entry.text };
    } else {
      throw Error(`Missing translation for comment
'${text}'
        with id of ${engId}`);
    }
  }, {});
}

function getChallengesDirForLang(lang) {
  return path.resolve(challengesDir, `./${lang}`);
}

function getMetaForBlock(block) {
  return JSON.parse(
    fs.readFileSync(path.resolve(metaDir, `./${block}/meta.json`), 'utf8')
  );
}

exports.getChallengesDirForLang = getChallengesDirForLang;
exports.getMetaForBlock = getMetaForBlock;

exports.getChallengesForLang = function getChallengesForLang(lang) {
  let curriculum = {};
  return new Promise(resolve => {
    let running = 1;
    function done() {
      if (--running === 0) {
        resolve(curriculum);
      }
    }
    readDirP({ root: getChallengesDirForLang(lang) })
      .on('data', file => {
        running++;
        buildCurriculum(file, curriculum, lang).then(done);
      })
      .on('end', done);
  });
};

async function buildCurriculum(file, curriculum, lang) {
  const { name, depth, path: filePath, stat } = file;
  const createChallenge = createChallengeCreator(challengesDir, lang);
  if (depth === 1 && stat.isDirectory()) {
    // extract the superBlock info
    const { order, name: superBlock } = superBlockInfo(name);
    curriculum[superBlock] = { superBlock, order, blocks: {} };
    return;
  }
  if (depth === 2 && stat.isDirectory()) {
    const blockName = getBlockNameFromPath(filePath);
    const metaPath = path.resolve(
      __dirname,
      `./challenges/_meta/${blockName}/meta.json`
    );
    const blockMeta = require(metaPath);
    const { isUpcomingChange } = blockMeta;
    if (typeof isUpcomingChange !== 'boolean') {
      throw Error(
        `meta file at ${metaPath} is missing 'isUpcomingChange', it must be 'true' or 'false'`
      );
    }

    if (!isUpcomingChange || process.env.SHOW_UPCOMING_CHANGES === 'true') {
      // add the block to the superBlock
      const { name: superBlock } = superBlockInfoFromPath(filePath);
      const blockInfo = { meta: blockMeta, challenges: [] };
      curriculum[superBlock].blocks[name] = blockInfo;
    }
    return;
  }
  if (name === 'meta.json' || name === '.DS_Store') {
    return;
  }

  const block = getBlockNameFromPath(filePath);
  const { name: superBlock } = superBlockInfoFromPath(filePath);
  let challengeBlock;

  // TODO: this try block and process exit can all go once errors terminate the
  // tests correctly.
  try {
    challengeBlock = curriculum[superBlock].blocks[block];
    if (!challengeBlock) {
      // this should only happen when a isUpcomingChange block is skipped
      return;
    }
  } catch (e) {
    console.log(`failed to create superBlock ${superBlock}`);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
  const { meta } = challengeBlock;

  const challenge = await createChallenge(filePath, meta);

  challengeBlock.challenges = [...challengeBlock.challenges, challenge];
}

async function parseTranslation(
  engPath,
  transPath,
  dict,
  lang,
  parse = parseMD
) {
  const engChal = await parse(engPath);
  const translatedChal = await parse(transPath);

  // challengeType 11 is for video challenges, which have no seeds, so we skip
  // them.
  const engWithTranslatedComments =
    engChal.challengeType !== 11
      ? translateCommentsInChallenge(engChal, lang, dict)
      : engChal;
  return mergeChallenges(engWithTranslatedComments, translatedChal);
}

function createChallengeCreator(basePath, lang) {
  const hasEnglishSource = hasEnglishSourceCreator(basePath);
  return async function createChallenge(filePath, maybeMeta) {
    function getFullPath(pathLang) {
      return path.resolve(__dirname, basePath, pathLang, filePath);
    }
    let meta;
    if (maybeMeta) {
      meta = maybeMeta;
    } else {
      const metaPath = path.resolve(
        metaDir,
        `./${getBlockNameFromPath(filePath)}/meta.json`
      );
      meta = require(metaPath);
    }
    const { name: superBlock } = superBlockInfoFromPath(filePath);
    if (!supportedLangs.includes(lang))
      throw Error(`${lang} is not a accepted language.
  Trying to parse ${filePath}`);
    if (lang !== 'english' && !(await hasEnglishSource(filePath)))
      throw Error(`Missing English challenge for
${filePath}
It should be in
${getFullPath('english')}
`);
    // assumes superblock names are unique
    // while the auditing is ongoing, we default to English for un-audited certs
    // once that's complete, we can revert to using isEnglishChallenge(fullPath)
    const useEnglish = lang === 'english' || !isAuditedCert(lang, superBlock);
    const isCert = path.extname(filePath) === 'markdown';
    let challenge;

    if (isCert) {
      challenge = await (useEnglish
        ? parseMarkdown(getFullPath('english'))
        : parseTranslation(
            getFullPath('english'),
            getFullPath(lang),
            COMMENT_TRANSLATIONS,
            lang,
            parseMarkdown
          ));
    } else {
      challenge = await (useEnglish
        ? parseMD(getFullPath('english'))
        : parseTranslation(
            getFullPath('english'),
            getFullPath(lang),
            COMMENT_TRANSLATIONS,
            lang
          ));
    }
    const challengeOrder = findIndex(
      meta.challengeOrder,
      ([id]) => id === challenge.id
    );
    const {
      name: blockName,
      order,
      superOrder,
      isPrivate,
      required = [],
      template,
      time
    } = meta;
    challenge.block = blockName;
    challenge.dashedName =
      lang === 'english'
        ? dasherize(challenge.title)
        : dasherize(challenge.originalTitle);
    delete challenge.originalTitle;
    challenge.order = order;
    challenge.superOrder = superOrder;
    challenge.superBlock = superBlock;
    challenge.challengeOrder = challengeOrder;
    challenge.isPrivate = challenge.isPrivate || isPrivate;
    challenge.required = required.concat(challenge.required || []);
    challenge.template = template;
    challenge.time = time;
    challenge.helpCategory =
      challenge.helpCategory || helpCategoryMap[dasherize(blockName)];

    return prepareChallenge(challenge);
  };
}

// TODO: tests and more descriptive name.
function filesToObject(files) {
  return reduce(
    files,
    (map, file) => {
      map[file.key] = {
        ...file,
        head: arrToString(file.head),
        contents: arrToString(file.contents),
        tail: arrToString(file.tail)
      };
      return map;
    },
    {}
  );
}

// gets the challenge ready for sourcing into Gatsby
function prepareChallenge(challenge) {
  challenge.name = nameify(challenge.title);
  if (challenge.files) {
    challenge.files = filesToObject(challenge.files);
    challenge.files = Object.keys(challenge.files)
      .filter(key => challenge.files[key])
      .map(key => challenge.files[key])
      .reduce(
        (files, file) => ({
          ...files,
          [file.key]: {
            ...createPoly(file),
            seed: file.contents.slice(0)
          }
        }),
        {}
      );
  }

  if (challenge.solutionFiles) {
    challenge.solutionFiles = filesToObject(challenge.solutionFiles);
  }
  challenge.block = dasherize(challenge.block);
  challenge.superBlock = blockNameify(challenge.superBlock);
  return challenge;
}

function hasEnglishSourceCreator(basePath) {
  const englishRoot = path.resolve(__dirname, basePath, 'english');
  return async function(translationPath) {
    return await access(
      path.join(englishRoot, translationPath),
      fs.constants.F_OK
    )
      .then(() => true)
      .catch(() => false);
  };
}

function superBlockInfoFromPath(filePath) {
  const [maybeSuper] = filePath.split(path.sep);
  return superBlockInfo(maybeSuper);
}

function superBlockInfo(fileName) {
  const [maybeOrder, ...superBlock] = fileName.split('-');
  let order = parseInt(maybeOrder, 10);
  if (isNaN(order)) {
    return { order: 0, name: fileName };
  } else {
    return {
      order: order,
      name: superBlock.join('-')
    };
  }
}

function getBlockNameFromPath(filePath) {
  const [, block] = filePath.split(path.sep);
  return block;
}

function arrToString(arr) {
  return Array.isArray(arr) ? arr.join('\n') : toString(arr);
}

exports.hasEnglishSourceCreator = hasEnglishSourceCreator;
exports.parseTranslation = parseTranslation;
exports.createChallengeCreator = createChallengeCreator;
