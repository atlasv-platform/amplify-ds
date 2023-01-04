#!/usr/bin/env node
const _ = require('lodash');
const aws = require('aws-sdk');
const yargs = require("yargs");
const chalk = require("chalk");
const boxen = require("boxen");
const AWSAppSyncClient = require('aws-appsync').default;
const gql = require('graphql-tag');
const XLSX = require('xlsx');
const fs = require('fs');
const Confirm = require('prompt-confirm');
const Synchronizer = require('@okwenxi/dynamodb-table-sync');
const { record } = require('apollo-cache-inmemory');
const prompt = new Confirm('Do you confirm to start syncing?');
global.fetch = require("node-fetch");

let amplifyConfig, amplifyMeta
try {
    const options = yargs
        .help()
        .demandCommand()
        .command('sync <model> <src> <dest> [--delete] [--dryrun]', 'sync model data from <src> env to <dest> env. When add [--delete], data that only exist in dest will  be deleted.')
        .command('import <model> <file>', 'import model data from excel file.')
        .command('export <model> [file] [--after timestamp] [--all]', 'export model data to excel file, you can add --after to only export data older than [timestamp] parameter; add --all to show all data include deleted.')
        .command('example <model> [file]', 'export example excel file for a model.')
        .argv;
    amplifyConfig = require(`${process.env['HOME']}/.amplify/admin/config.json`);
    amplifyMeta = require(`${process.cwd()}/amplify/#current-cloud-backend/amplify-meta.json`);
    const appId = amplifyMeta.providers.awscloudformation.AmplifyAppId;
    const gqlEndpoint = Object.values(amplifyMeta.api)[0].output.GraphQLAPIEndpointOutput;

    switch (options._[0]) {
        case 'sync':
            try {
                initToken(appId).then(async (config) => {
                    try {
                        const modelName = options.model;
                        const amplifybackend = new aws.AmplifyBackend();
                        const appsync = new aws.AppSync();
                        const srcMD = await amplifybackend.getBackend({
                            AppId: appId,
                            BackendEnvironmentName: options.src
                        }).promise();
                        // const srcgqlEndpoint = Object.values(JSON.parse(srcMD.AmplifyMetaConfig).api)[0].output.GraphQLAPIEndpointOutput;
                        const srcAPIID = Object.values(JSON.parse(srcMD.AmplifyMetaConfig).api)[0].output.GraphQLAPIIdOutput;
                        const srcDS = await appsync.getDataSource({
                            apiId: srcAPIID,
                            name: `${modelName}Table`
                        }).promise();
                        const srcDB = srcDS.dataSource.dynamodbConfig.tableName;

                        const destMD = await amplifybackend.getBackend({
                            AppId: appId,
                            BackendEnvironmentName: options.dest
                        }).promise();
                        // const destgqlEndpoint = Object.values(JSON.parse(destMD.AmplifyMetaConfig).api)[0].output.GraphQLAPIEndpointOutput;
                        const destAPIID = Object.values(JSON.parse(destMD.AmplifyMetaConfig).api)[0].output.GraphQLAPIIdOutput;
                        const destDS = await appsync.getDataSource({
                            apiId: destAPIID,
                            name: `${modelName}Table`
                        }).promise();
                        const destDB = destDS.dataSource.dynamodbConfig.tableName;
                        info(`Starting Sync ${destDB} from ${srcDB}`);
                        const syncParams = {ignoreAtts:['_version','_lastChangedAt','updatedAt','createdAt']};
                        if (!options.dryrun) {
                            syncParams.writeMissing = true;
                            syncParams.writeDiffering = true;
                            if (options.delete) {
                                syncParams.scanForExtra = true;
                                syncParams.deleteExtra = true;
                            }
                            const answer = await prompt.run();
                            if (!answer) {
                                process.exit();
                            }
                        } else {
                            if (options.delete) {
                                syncParams.scanForExtra = true;
                            }
                        }
                        const synchronizer = new Synchronizer(
                            { region: config.region, name: srcDB,creds:config },
                            [
                                { region: config.region, name: destDB,creds:config },
                            ],
                            syncParams
                        );
                        await synchronizer.run();
                        if (options.dryrun) {
                            info('Please Check the status above to see the differences.');
                        } else {
                            info(`Datasource ${srcDB} ${destDB} has been synced.`);
                        }
                    } catch (e) {
                        error(e);
                    }
                });
            } catch (err) {
                error(err);
            }
            break;
        case 'export':
            initToken(appId).then(async (config) => {
                const client = new AWSAppSyncClient({
                    url: gqlEndpoint,
                    region: config.region,
                    auth: {
                        type: 'AWS_IAM',
                        credentials: aws.config.credentials,
                    },
                    disableOffline: true
                });
                let outputFile = `${options.model}.xlsx`
                if (options.file)
                    outputFile = options.file
                const modelName = options.model;
                fs.readFile(`${process.cwd()}/amplify/#current-cloud-backend/api/${Object.keys(amplifyMeta.api)[0]}/schema.graphql`, 'utf8', async function (err, data) {
                    if (err) {
                        return error(err);
                    }
                    const modelFields = [];
                    const typeDefs = gql`${data}`
                    typeDefs.definitions.some(def => {
                        if (def.kind === 'ObjectTypeDefinition') {
                            if (def.name.value === modelName) {
                                def.fields.forEach(field => {
                                    if (field.kind === 'FieldDefinition') {
                                        if (field.type.kind === 'NamedType') {
                                            modelFields.push(field.name.value);
                                        } else if (field.type.kind === 'NonNullType') {
                                            modelFields.push(field.name.value);
                                        }
                                    }

                                })
                                return true;
                            }
                        }
                    });
                    if (modelFields.length > 0) {
                        await client.hydrated();
                        let exportedData = [];
                        let nextToken;
                        do {
                            const queryGQL = gql(`
                                query List${modelName}s {
                                    list${modelName}s${nextToken?`(nextToken: "${nextToken}")`:''} {
                                        items {
                                            ${modelFields.join('\n')}
                                            _lastChangedAt
                                            _version
                                            _deleted
                                        }
                                        nextToken
                                    }
                                }
                            `);
                            const response = await client.query({
                                query: queryGQL,
                                fetchPolicy: 'no-cache',
                            });
                            Array.prototype.push.apply(exportedData, response.data[`list${modelName}s`].items);
                            nextToken = response.data[`list${modelName}s`].nextToken;
                            // console.info(`nextToken: ${nextToken}`);
                            // console.info(`exportedData: \n`);
                            // console.info(exportedData);
                        } while (nextToken)

                        if (options.after) {
                            const afterTime = parseInt(options.after);
                            exportedData = exportedData.filter(record => record._lastChangedAt > afterTime);
                        }
                        if(!options.all) {
                            exportedData = exportedData.filter(record => !record._deleted);
                        }
                        const sheet = XLSX.utils.json_to_sheet(exportedData);
                        const exportBook = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(exportBook, sheet, modelName);
                        XLSX.writeFile(exportBook, outputFile);
                        info(`${exportedData.length} items have been export to ${outputFile}`);
                    } else {
                        error('Model Definition not found!');
                    }
                });
            }).catch(error);

            break;
        case 'import':
            initToken(appId).then(async (config) => {
                const client = new AWSAppSyncClient({
                    url: gqlEndpoint,
                    region: config.region,
                    auth: {
                        type: 'AWS_IAM',
                        credentials: aws.config.credentials,
                    },
                    disableOffline: true
                });
                const modelName = options.model;
                const workbook = XLSX.readFile(options.file);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const items = XLSX.utils.sheet_to_json(sheet);
                const headers = get_header_row(sheet);
                const results = _.map(items, function (currentObject) {
                    return _.pick(currentObject, headers);
                });
                const queryGQL = gql(`
                            query Get${modelName}($id: ID!) {
                                get${modelName}(id: $id) {
                                    ${headers.join('\n')}
                                    _version
                                }
                            }
                        `);
                const updateGQL = gql(`
                        mutation Update${modelName}(
                            $input: Update${modelName}Input!
                        ) {
                            update${modelName}(input: $input) {
                               id
                            }
                        }
                    `);
                const mutationGQL = gql(`
                        mutation Create${modelName}(
                            $input: Create${modelName}Input!
                        ) {
                            create${modelName}(input: $input) {
                               id
                            }
                        }
                    `);
                let totalAddCount = 0;
                let totalUpdateCount = 0;
                await client.hydrated();
                for (let index = 0; index < results.length; index++) {
                    const item = results[index];
                    let queryRes;
                    if (item.id) {
                        queryRes = await client.query({
                            query: queryGQL,
                            fetchPolicy: 'no-cache',
                            variables: { id: item.id },
                        });
                    }
                    if (queryRes && queryRes.data && queryRes.data[`get${modelName}`]) { //exist
                        if (isEqual(queryRes.data[`get${modelName}`], item, ['__typename','_version'])) {
                            continue;
                        } else {
                            item['_version'] = queryRes.data[`get${modelName}`]['_version'];
                            const response = await client.mutate({
                                mutation: updateGQL, variables: {
                                    input: item
                                },
                                fetchPolicy: 'no-cache',
                            });
                            log(`${JSON.stringify(response.data)} updated`);
                            totalUpdateCount++;
                        }
                    } else {
                        const response = await client.mutate({
                            mutation: mutationGQL, variables: {
                                input: item
                            },
                            fetchPolicy: 'no-cache',
                        });
                        log(`${JSON.stringify(response.data)} added`);
                        totalAddCount++;
                    }
                }
                info(`${totalAddCount} items have been added to datastore!\n${totalUpdateCount} items have been update in datastore!`);
            }).catch(error);
            break;
        case 'example':
            let outputFile = `${options.model}.xlsx`
            if (options.file)
                outputFile = options.file
            fs.readFile(`${process.cwd()}/amplify/#current-cloud-backend/api/${Object.keys(amplifyMeta.api)[0]}/schema.graphql`, 'utf8', function (err, data) {
                if (err) {
                    return error(err);
                }
                const modelObj = {};
                const typeDefs = gql`${data}`
                typeDefs.definitions.forEach(def => {
                    if (def.kind === 'ObjectTypeDefinition') {
                        if (def.name.value === options.model) {
                            def.fields.forEach(field => {
                                if (field.kind === 'FieldDefinition') {
                                    if (field.type.kind === 'NamedType') {
                                        modelObj[field.name.value] = field.type.name.value;
                                    } else if (field.type.kind === 'NonNullType') {
                                        modelObj[field.name.value] = field.type.type.name.value;
                                    }
                                }

                            })
                        }
                    }
                });
                if (Object.keys(modelObj).length > 0) {
                    const sheet = XLSX.utils.json_to_sheet([modelObj]);
                    const example = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(example, sheet, options.model);
                    XLSX.writeFile(example, outputFile);
                } else {
                    error('Model Definition not found!');
                }
            });
            break;
    }
} catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
        if (!amplifyConfig) {
            error('Amplify Credentials has not been created!');
        } if (!amplifyMeta) {
            error('Amplify Project Not Found! Please run this command in the project root.');
        } else {
            error(err);
        }
    } else {
        error(err);
    }

}

function promiseChildProcess(child) {
    return new Promise(function (resolve, reject) {
        child.addListener("error", reject);
        child.addListener("exit", resolve);
    });
}

function isEqual(item1, item2, ignores) {
    return _.isEqual(_.omit(item1, ignores), _.omit(item2, ignores));
}


function get_header_row(sheet) {
    var headers = [];
    var range = XLSX.utils.decode_range(sheet['!ref']);
    var C, R = range.s.r; /* start in the first row */
    /* walk every column in the range */
    for (C = range.s.c; C <= range.e.c; ++C) {
        var cell = sheet[XLSX.utils.encode_cell({ c: C, r: R })] /* find the cell in the first row */
        if (cell && cell.t) {
            hdr = XLSX.utils.format_cell(cell);
            headers.push(hdr);
        }
    }
    return headers.filter(header => {
        return header.match(/^[^_^\d][a-zA-Z_\-\d]*/);
    });
}


async function initToken(appId) {
    admin = amplifyConfig[appId];
    if (isJwtExpired(admin.idToken)) {
        refreshResult = await refreshJWTs(admin);
        admin.idToken.jwtToken = refreshResult.IdToken;
        admin.accessToken.jwtToken = refreshResult.AccessToken;
    }
    awsConfig = await getAdminCognitoCredentials(admin.idToken, admin.IdentityId, admin.region);
    aws.config.update(awsConfig);
    return awsConfig;
}

async function getAdminCognitoCredentials(idToken, identityId, region) {
    const cognitoIdentity = new aws.CognitoIdentity({ region });
    const login = idToken.payload.iss.replace('https://', '');
    const { Credentials } = await cognitoIdentity
        .getCredentialsForIdentity({
            IdentityId: identityId,
            Logins: {
                [login]: idToken.jwtToken,
            },
        })
        .promise();

    return {
        accessKeyId: Credentials.AccessKeyId,
        expiration: Credentials.Expiration,
        region,
        secretAccessKey: Credentials.SecretKey,
        sessionToken: Credentials.SessionToken,
    };
}
async function refreshJWTs(authConfig) {
    const CognitoISP = new aws.CognitoIdentityServiceProvider({ region: authConfig.region });
    try {
        const result = await CognitoISP.initiateAuth({
            AuthFlow: 'REFRESH_TOKEN',
            AuthParameters: {
                REFRESH_TOKEN: authConfig.refreshToken.token,
            },
            ClientId: authConfig.accessToken.payload.client_id, // App client id from identityPool
        }).promise();
        return result.AuthenticationResult;
    } catch (e) {
        console.error(`Failed to refresh tokens: ${e.message || 'Unknown error occurred'}`);
        throw e;
    }
}
function isJwtExpired(token) {
    const expiration = _.get(token, ['payload', 'exp'], 0);
    const secSinceEpoch = Math.round(new Date().getTime() / 1000);
    return secSinceEpoch >= expiration - 60;
}
function log(str) {
    const msg = chalk.green.bold(str);
    console.log(msg);
}
function info(str) {
    const msg = chalk.green.bold(str);
    const boxenOptions = {
        padding: 1,
        borderColor: 'blue',
    };
    const msgBox = boxen(msg, boxenOptions);
    console.log(msgBox);
}
function error(str) {
    const msg = chalk.red.bold(str);
    const boxenOptions = {
        padding: 1,
        borderColor: 'blue',
    };
    const msgBox = boxen(msg, boxenOptions);
    console.log(msgBox);
}