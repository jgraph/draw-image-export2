# draw-image-export2
The current server-side PNG/PDF export implementation using Node, Puppeteer and Chrome headless

## Running the service (this is your instructions, not the next section)
* npm install
* npm start

## Updating internal draw.io versions (internal only)

* su chrome
* cd ~/draw-image-export2
* git pull
* npm install
* forever restartall

## Usage
This service accepts the following (url encoded) parameters provided via a HTTP (GET or POST) request. All parameters are optional except where emboldened.

`data-string` means a string of data that has been:
1. deflated _then_
2. base64 encoded _then_
3. url-encoded

There are 2 available modes for the service:
1. _(mode 1)_ Render some html that is provided
2. _(mode 2)_ Render a diagram from some html (which can be provided or retrieved from a given url)

### Mode 1: Provide some html to render

| Argument | Type | Purpose | Default | Example |
| ---- | ---- | ---- | ---- | ---- |
| **html** | data-string | html to render |  | - |
| w | number | Set the view port height | 0 | 10 |
| h | number | Set the view port width | 0 | 10 |

Note: Format is fixed to `png` for this mode.

### Mode 2: Render a diagram
To render a diagram, the `diagram-data` must be retrieved, this is the draw.io data that can be used to re-render the diagram. There are 2 modes to get this data:
1. _(mode 2.1)_ Provide a url to a resource
1. _(mode 2.2)_ Provide the data in the request

Whichever option is used the following process will be followed to extract the diagram data:
1. If the data is a XHTML document (well-structured HTML)
   1. For the first `div` with the `mxgraph` class defined
   1. Use the data in the `data-mxgraph` attribute (if one is present) _OR_
   1. Use the text content of the element
1. If the data is a SVG image
   1. Extract the diagram data from the `content` attribute if possible, otherwise use as-is

#### Mode 2.1: Get `diagram-data` from url

| Argument | Type | Purpose | Default | Example |
| ---- | ---- | ---- | ---- | ---- |
| **url** | string | absolute url to diagram to render |  | - |

#### Mode 2.2: Get `diagram-data` from xml (or svg)
Provide either `xmldata` or `xml`, `xmldata` takes precedence.

| Argument | Type | Purpose | Default | Example |
| ---- | ---- | ---- | ---- | ---- |
| **xmldata** | data-string | Content of the diagram to render |  | - |
| **xml** | string (optionally url-encoded) | Content of the diagram to render |  | - |

#### Common parameters
| Argument | Type | Purpose | Default | Example |
| ---- | ---- | ---- | ---- | ---- |
| format§ (see below) | string | The renderering format for the diagram | png | pdf |
| w§ | number | Set the view port height | 0 | 10 |
| h§ | number | Set the view port width | 0 | 10 |
| embedXml* | string | Embed the diagram data in the png | | "0" or "1" |
| base64 | string | Whether the response data should be base64 (and png embedded data) encoded | | "0" or "1" |
| bg§ | string | The background colour for the image | | "#ff8888" |
| embedData* | string | Embed `data` in the png with the `dataHeader` key | null | "0" or "1" |
| data* | string | The data to embed into the png | | - |
| dataHeader* | string | The key to use when embedding the `data` into the png | | "myKey" |
| filename | string | The filename to included in the content-disposition header | | "myFile.png" |
| border¶ | number | The size of the border for the page | 0 | 10 |
| from¶ | number | The index of the page to start rendering from | | 1 |
| to¶ | number | The index of the page to finish rendering at | | 2 |
| pageId¶ | string | The id of the page to render | | "page id" |
| allPages¶ | string | Whether all pages should be rendered | "0" | "0" or "1" |
| scale¶ | number | The scale for the rendered diagram | 1 | 1.5 |
| extras¶ | json-string | Additional detail how what should be rendered, e.g. layer-names | | ? |

\* Only applicable when format is `png`.
§ means property is used by both this service and draw.io (https://www.draw.io/export3.html) to control how the diagram is rendered.
¶ means property is passed to draw.io (https://www.draw.io/export3.html) to control how the diagram is rendered.

### Formats
The following formats can be used
- 'png' (default)
- 'jpg' (or 'jpeg')
- 'pdf'

## Examples
### Example 1 (render a diagram in png format from provided diagram data)

```
POST https://exp-pdf.draw.io/ImageExport4/export HTTP/1.1
Host: exp-pdf.draw.io
Content-Type: application/x-www-form-urlencoded
Content-Length: 1234

format=png&xml=%3Cmxfile+...
```

### Example 2 (render a diagram in png format from provided url - to a diagram file)

```
GET https://exp-pdf.draw.io/ImageExport4/export?format=png&bg=ffffff&url=https://somewhere/diagram.xml HTTP/1.1
Host: exp-pdf.draw.io
```
