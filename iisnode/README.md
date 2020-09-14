# Windows Deployment Using IIS

The following are the steps to deploy export server on IIS using [iisnode](https://github.com/Azure/iisnode). Most steps are from iisnode README

1. Install [rewrite module](https://www.iis.net/downloads/microsoft/url-rewrite)
2. Install latest [node.js for windows](https://nodejs.org/en/download/) (LTS is recommended)
3. Install [latest iisnode release](https://github.com/azure/iisnode/releases)
4. Setup iisnode samples, from the administrative command prompt call `%programfiles%\iisnode\setupsamples.bat`
5. Samples will create a virtual directory `node` and will point to `%programfiles%\iisnode\www`
6. Empty www folder and then checkout export server in it.
7. In command prompt, change directory to `www` and run `npm install`
8. Copy `web.config` from from the project `iisnode` directory to `www`
9. Test export server work by opening `http://localhost/node/export`, it should show `BAD REQUEST`
10. Delete all files and folders in `www` except for `export.js`, `web.config`, and `node_modules`. The app will create `iisnode` directory which contains the logs in addition to three logs files in `www`.
