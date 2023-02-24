# amplify-ds

Use amplify project config to manage `datastore` , get example excel file for a model and import data from that file. You must running the command in the root of the project.

## Install
```
npm install -g amplify-ds
```

## Usage

```
amplifyds <command>

Commands:
  amplifyds sync <model> <src> <dest>        sync model data from <src> env to
  [--delete] [--dryrun]                      <dest> env. When add [--delete],
                                             data that only exist in dest will
                                             be deleted.

  amplifyds import <model> <file>            import model data from excel file.

  amplifyds export <model> [file] [--after   export model data to excel file, you
  timestamp] [--all]                         can add --after to only export data
                                             older than [timestamp] parameter;
                                             add --all to show all data include
                                             deleted.

  amplifyds schema <file>                    list all tables in this schema.

  amplifyds validate                         check if current init token is
                                             validate. Output
                                             USER_TOKEN_VALIDATE_PASSED if ok,
                                             otherwise output
                                             USER_TOKEN_VALIDATE_FAILED.
                                             
  amplifyds example <model> [file]           export example excel file for a
                                             model.
```
* Use `--dryrun` in `sync` command before actually starting sync process to see the differ overview
* Use `--delete` in `sync` command to delete isolated data that only exist in destination
* If a model already has some data in datasource, you can first `export` these data to a excel file and modify them, then you can `import` the file to update these data without deleting or duplicating them
* When `export` model data, use [--after timestamp] to only export newer data you want, use [--all] to export all data include deleted data

