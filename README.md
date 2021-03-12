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
  amplifyds import <model> <file>                       import model data from excel file.
  amplifyds export <model> [file] [--after timestamp]   export model data to excel file, you can add --after to only export data older than [timestamp] parameter.
  amplifyds example <model> [file]                      export example excel file for a model.

```
