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

global.fetch = require("node-fetch");

let amplifyConfig, amplifyMeta
try {
    const options = yargs
        .help()
        .demandCommand()
        .command('import <model> <file>', 'import model data from excel file.')
        .command('example <model> [file]', 'export example excel file for a model.')
        .argv;
    amplifyConfig = require(`${process.env['HOME']}/.amplify/admin/config.json`);
    amplifyMeta = require(`${process.cwd()}/amplify/#current-cloud-backend/amplify-meta.json`);
    const appId = amplifyMeta.providers.awscloudformation.AmplifyAppId;
    const gqlEndpoint = Object.values(amplifyMeta.api)[0].output.GraphQLAPIEndpointOutput;

    switch (options._[0]) {
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
                const mutationGQL = gql(`
                        mutation Create${modelName}(
                            $input: Create${modelName}Input!
                        ) {
                            create${modelName}(input: $input) {
                               id
                            }
                        }
                    `);
                let totalCount = 0;
                await client.hydrated();
                for (let index = 0; index < results.length; index++) {
                    const item = results[index];
                    const response = await client.mutate({
                        mutation: mutationGQL, variables: {
                            input: item
                        },
                        fetchPolicy: 'no-cache',
                    });
                    totalCount++;
                    log(`${JSON.stringify(response.data)} added`);
                }
                info(`${totalCount} items have been added to datastore!`);
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
        return header.match(/[a-zA-Z_\-0-9]/);
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