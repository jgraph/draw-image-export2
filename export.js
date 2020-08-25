const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const winston = require('winston');
const compression = require('compression');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
const fetch = require('node-fetch');
const crc = require('crc');
const hummus = require('hummus');
const memoryStreams = require('memory-streams');

const MAX_AREA = 15000 * 15000;
const PNG_CHUNK_IDAT = 1229209940;
var DOMParser = require('xmldom').DOMParser;

const PORT = process.env.PORT || 8000

const app = express();

//Max request size is 10 MB
app.use(bodyParser.urlencoded({ extended: false, limit: '10mb'}));
app.use(bodyParser.json({ limit: '10mb' }));

app.use(compression({
    threshold: 10,
}));

//Enable request logging using morgan and Apache combined format
app.use(morgan('combined'));

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    //
    // - Write to all logs with level `info` and below to `combined.log` 
    // - Write all logs error (and below) to `error.log`.
    //
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: 'exceptions.log' })
  ]
});

//If we're not in production then log to the `console` also
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}
  
// NOTE: Key length must not be longer than 79 bytes (not checked)
function writePngWithText(origBuff, key, text, compressed, base64encoded)
{
	var isDpi = key == 'dpi';
	var inOffset = 0;
	var outOffset = 0;
	var data = text;
	var dataLen = isDpi? 9 : key.length + data.length + 1; //we add 1 zeros with non-compressed data, for pHYs it's 2 of 4-byte-int + 1 byte
	
	//prepare compressed data to get its size
	if (compressed)
	{
		data = zlib.deflateRawSync(encodeURIComponent(text));
		dataLen = key.length + data.length + 2; //we add 2 zeros with compressed data
	}
	
	var outBuff = Buffer.allocUnsafe(origBuff.length + dataLen + 4); //4 is the header size "zTXt", "tEXt" or "pHYs"
	
	try
	{
		var magic1 = origBuff.readUInt32BE(inOffset);
		inOffset += 4;
		var magic2 = origBuff.readUInt32BE(inOffset);
		inOffset += 4;
		
		if (magic1 != 0x89504e47 && magic2 != 0x0d0a1a0a)
		{
			throw new Error("PNGImageDecoder0");
		}
		
		outBuff.writeUInt32BE(magic1, outOffset);
		outOffset += 4;
		outBuff.writeUInt32BE(magic2, outOffset);
		outOffset += 4;
	}
	catch (e)
	{
		logger.error(e.message, {stack: e.stack});
		throw new Error("PNGImageDecoder1");
	}

	try
	{
		while (inOffset < origBuff.length)
		{
			var length = origBuff.readInt32BE(inOffset);
			inOffset += 4;
			var type = origBuff.readInt32BE(inOffset)
			inOffset += 4;

			if (type == PNG_CHUNK_IDAT)
			{
				// Insert zTXt chunk before IDAT chunk
				outBuff.writeInt32BE(dataLen, outOffset);
				outOffset += 4;
				
				var typeSignature = isDpi? 'pHYs' : (compressed ? "zTXt" : "tEXt");
				outBuff.write(typeSignature, outOffset);
				
				outOffset += 4;

				if (isDpi)
				{
					var dpm = Math.round(parseInt(text) / 0.0254) || 3937; //One inch is equal to exactly 0.0254 meters. 3937 is 100dpi

					outBuff.writeInt32BE(dpm, outOffset);
					outBuff.writeInt32BE(dpm, outOffset + 4);
					outBuff.writeInt8(1, outOffset + 8);
					outOffset += 9;

					data = Buffer.allocUnsafe(9);
					data.writeInt32BE(dpm, 0);
					data.writeInt32BE(dpm, 4);
					data.writeInt8(1, 8);
				}
				else
				{
					outBuff.write(key, outOffset);
					outOffset += key.length;
					outBuff.writeInt8(0, outOffset);
					outOffset ++;

					if (compressed)
					{
						outBuff.writeInt8(0, outOffset);
						outOffset ++;
						data.copy(outBuff, outOffset);
					}
					else
					{
						outBuff.write(data, outOffset);	
					}

					outOffset += data.length;				
				}

				var crcVal = 0xffffffff;
				crcVal = crc.crcjam(typeSignature, crcVal);
				crcVal = crc.crcjam(data, crcVal);

				// CRC
				outBuff.writeInt32BE(crcVal ^ 0xffffffff, outOffset);
				outOffset += 4;

				// Writes the IDAT chunk after the zTXt
				outBuff.writeInt32BE(length, outOffset);
				outOffset += 4;
				outBuff.writeInt32BE(type, outOffset);
				outOffset += 4;

				origBuff.copy(outBuff, outOffset, inOffset);

				// Encodes the buffer using base64 if requested
				return base64encoded? outBuff.toString('base64') : outBuff;
			}

			outBuff.writeInt32BE(length, outOffset);
			outOffset += 4;
			outBuff.writeInt32BE(type, outOffset);
			outOffset += 4;

			origBuff.copy(outBuff, outOffset, inOffset, inOffset + length + 4);// +4 to move past the crc
			
			inOffset += length + 4;
			outOffset += length + 4;
		}
	}
	catch (e)
	{
		logger.error(e.message, {stack: e.stack});
		throw e;
	}
}

function padNumber(n, width, z)
{
	z = z || '0';
	n = n + '';
	
	return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

function appendPDFPageFromPDFWithAnnotations(pdfWriter, sourcePDF) 
{
    var cpyCxt = pdfWriter.createPDFCopyingContext(sourcePDF);
    var cpyCxtParser = cpyCxt.getSourceDocumentParser();
    
    // for each page
	for(var i = 0; i < cpyCxtParser.getPagesCount(); ++i) 
	{
        // grab page dictionary
        var pageDictionary = cpyCxtParser.parsePageDictionary(i);
		
		if(!pageDictionary.exists('Annots')) 
		{
            // no annotation. append as is
            cpyCxt.appendPDFPageFromPDF(i);            
        }
		else 
		{
            // this var here will save any reffed objects from the copied annotations object.
            // they will be written after the page copy writing as to not to disturb the
            // page object writing itself.
            var reffedObjects;

			pdfWriter.getEvents().once('OnPageWrite', function(params) 
			{
                // using the page write event, write the new annotations. just copy the object
                // as is, saving any referenced objects for future writes
                params.pageDictionaryContext.writeKey('Annots');
                reffedObjects = cpyCxt.copyDirectObjectWithDeepCopy(pageDictionary.queryObject('Annots'))
            })   

            // write page. this will trigger the event  
            cpyCxt.appendPDFPageFromPDF(i);
            
            // now write the reffed object (should be populated cause onPageWrite was written)
            // note that some or all annotations may be embedded, in which case this array
            // wont hold all annotation objects
			if(reffedObjects && reffedObjects.length > 0)
			{
				cpyCxt.copyNewObjectsForDirectObject(reffedObjects)
			}
        }
    }
}

function mergePdfs(pdfFiles, xml)
{
	//Pass throgh single files
	if (pdfFiles.length == 1 && xml == null)
	{
		return pdfFiles[0];
	}

	//We need to process the output, so we need to return a stream
	var outStream = new memoryStreams.WritableStream();

	try 
	{
		var pdfWriter = hummus.createWriter(new hummus.PDFStreamForResponse(outStream));

		var infoDictionary = pdfWriter.getDocumentContext().getInfoDictionary();
		infoDictionary.creator = 'diagrams.net';

		if (xml != null)
		{	
			// Uses Subject as it is not used
			infoDictionary.subject = encodeURIComponent(xml).replace(/\(/g, "\\(").replace(/\)/g, "\\)");
		}

		for (var i = 0; i < pdfFiles.length; i++)
		{
			appendPDFPageFromPDFWithAnnotations(pdfWriter, new hummus.PDFRStreamForBuffer(pdfFiles[i]))
		}

		pdfWriter.end();
		var newBuffer = outStream.toBuffer();
        outStream.end();

        return newBuffer;
    }
	catch(e)
	{
		outStream.end();
        throw new Error('Error during PDF combination: ' + e.message);
    }
}

app.post('/', handleRequest);
app.get('/', handleRequest);

async function handleRequest(req, res) 
{
  try
  {
	  //Merge all parameters into body such that get and post works the same	
	  Object.assign(req.body, req.params, req.query);
	  
	  // Checks for HTML export request
	  if (req.body.html)
	  {
		var html = req.body.html;

		logger.info("HTML export referer: " + req.get("referer"));

		var wp = req.body.w;
		var w = (wp == null) ? 0 : parseInt(wp);

		var hp = req.body.h;
		var h = (hp == null) ? 0 : parseInt(hp);
		var browser = null;

		try
		{
			//Handles buffer constructor deprecation
			if (Buffer.from && Buffer.from !== Uint8Array.from)
			{
				html = decodeURIComponent(
					zlib.inflateRawSync(
							Buffer.from(decodeURIComponent(html), 'base64')).toString());
			}
			else
			{
				html = decodeURIComponent(
					zlib.inflateRawSync(
							new Buffer(decodeURIComponent(html), 'base64')).toString());
			}
			
			browser = await puppeteer.launch({
				headless: true,
				args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
			});
			
			// Workaround for timeouts/zombies is to kill after 30 secs
			setTimeout(function()
			{
				browser.close();
			}, 30000);
			
			const page = await browser.newPage();
			await page.setContent(html, {waitUntil: "networkidle0"});

			page.setViewport({width: w, height: h});

			var data = await page.screenshot({
			  type: 'png'
			});

			// Cross-origin access should be allowed to now
			res.header("Access-Control-Allow-Origin", "*");
			res.header('Content-disposition', 'attachment; filename="capture.png"');
			res.header('Content-type', 'image/png');
			  
			res.end(data);

			browser.close();
		}
		catch (e)
		{
			if (browser != null)
			{
				browser.close();
			}
			
			logger.info("Inflate failed for HTML input: " + html);
			throw e;
		}
	  }
	  else
	  {	
		var xml;
		if (req.body.url)
		{
			var urlRes = await fetch(req.body.url);
			xml = await urlRes.text();
			
			if (req.body.format == null)
				req.body.format = 'png';
		}
		else if (req.body.xmldata)
		{
			try
			{
				xml = zlib.inflateRawSync(
						new Buffer(decodeURIComponent(req.body.xmldata), 'base64')).toString();
			}
			catch (e)
			{
				logger.info("Inflate failed for XML input: " + req.body.xmldata);
				throw e;
			}
		}
		else
		{
			xml = req.body.xml;
		}
		
		if (xml != null && xml.indexOf("%3C") == 0)
		{
			xml = decodeURIComponent(xml);
		}
		
		// Extracts the compressed XML from the DIV in a HTML document
		if (xml != null && (xml.indexOf("<!DOCTYPE html>") == 0
				|| xml.indexOf("<!--[if IE]><meta http-equiv") == 0)) //TODO not tested!
		{
			try
			{
				var doc = new DOMParser().parseFromString(xml);
				var divs = doc.documentElement
						.getElementsByTagName("div");

				if (divs != null && divs.length > 0
						&& "mxgraph" == (divs.item(0).attributes
								.getNamedItem("class").nodeValue))
				{
					if (divs.item(0).nodeType == 1)
					{
						if (divs.item(0).hasAttribute("data-mxgraph"))
						{
							var jsonString = divs.item(0).getAttribute("data-mxgraph");

							if (jsonString != null)
							{
								var obj = JSON.parse(jsonString);
								xml = obj["xml"];
							}
						}
						else
						{
							divs = divs.item(0).getElementsByTagName("div");

							if (divs != null && divs.length > 0)
							{
								var tmp = divs.item(0).textContent;

								if (tmp != null)
								{
									tmp = zlib.inflateRawSync(new Buffer(tmp, 'base64')).toString();
									
									if (tmp != null && tmp.length > 0)
									{
										xml = decodeURIComponent(tmp);
									}
								}
							}
						}
					}
				}
			}
			catch (e)
			{
				// ignore
			}
		}
		
		// Extracts the URL encoded XML from the content attribute of an SVG node
		if (xml != null && (xml.indexOf(
				"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">") == 0))
		{//TODO not tested!
			try
			{
				var doc = new DOMParser().parseFromString(xml);

				if (doc != null && doc.documentElement != null && doc
						.documentElement.nodeName == "svg")
				{
					var content = doc.documentElement.getAttribute("content");
					
					if (content != null)
					{
						xml = content;
						
						if (xml.charAt(0) == '%')
						{
							xml = decodeURIComponent(xml);
						}
					}
				}
			}
			catch (e)
			{
				// ignore
			}
		}
		
		req.body.w = req.body.w || 0;
		req.body.h = req.body.h || 0;
		
		// Checks parameters
		if (req.body.format && xml && req.body.w * req.body.h <= MAX_AREA)
		{
			var browser = null;
			
			try
			{
				var reqStr = ((xml != null) ? "xml=" + xml.length : "")
					+ ((req.body.embedXml != null) ? " embed=" + req.body.embedXml : "") + " format="
					+ req.body.format;
					
				req.body.xml = xml;

				var t0 = Date.now();
				
				browser = await puppeteer.launch({
					headless: true,
					args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
				});

				// Workaround for timeouts/zombies is to kill after 30 secs
				setTimeout(function()
				{
					browser.close();
				}, 30000);
				
				const page = await browser.newPage();
				await page.goto((process.env.DRAWIO_SERVER_URL || 'https://www.draw.io') + '/export3.html', {waitUntil: 'networkidle0'});
				
				async function rederPage(pageIndex)
				{
					await page.evaluate((body, pageIndex) => {
						return render({
							xml: body.xml,
							format: body.format,
							w: body.w,
							h: body.h,
							border: body.border || 0,
							bg: body.bg,
							from: pageIndex,
							to: pageIndex,
							pageId: body.pageId,
							scale: body.scale || 1,
							extras: body.extras
						});
					}, req.body, pageIndex);

					//default timeout is 30000 (30 sec)
					await page.waitForSelector('#LoadingComplete');
					
					var bounds = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('bounds'));
					var pageId = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('page-id'));
					var scale  = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('scale'));
					var pageCount  = parseInt(await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('pageCount')));
					var pdfOptions = {format: 'A4'};
					
					if (bounds != null)
					{
						bounds = JSON.parse(bounds);

						var isPdf = req.body.format == 'pdf';

						//Chrome generates Pdf files larger than requested pixels size and requires scaling
						//For images, the fixing scale shows scrollbars
						var fixingScale = isPdf? 0.959 : 1;

						var w = Math.ceil(Math.ceil(bounds.width + bounds.x) * fixingScale);
						
						// +0.1 fixes cases where adding 1px below is not enough
						// Increase this if more cropped PDFs have extra empty pages
						var h = Math.ceil(Math.ceil(bounds.height + bounds.y) * fixingScale + (isPdf? 0.1 : 0));

						page.setViewport({width: w, height: h});

						pdfOptions = {
							printBackground: true,
							width: w + 'px',
							height: (h + 1) + 'px', //the extra pixel to prevent adding an extra empty page
							margin: {top: '0px', bottom: '0px', left: '0px', right: '0px'}
						}
					}
					
					return {pdfOptions: pdfOptions, pageId: pageId, scale: scale, pageCount: pageCount, w: w, h: h};
				}

				// Cross-origin access should be allowed to now
				res.header("Access-Control-Allow-Origin", "*");
				
				var base64encoded = req.body.base64 == "1";
				
				if (req.body.format == 'png' || req.body.format == 'jpg' || req.body.format == 'jpeg')
				{
					var info = await rederPage(req.body.from || 0);
					var pageId = info.pageId, scale = info.scale, h = info.h, w = info.w;

					var data = await page.screenshot({
						omitBackground: req.body.format == 'png' && (req.body.bg == null || req.body.bg == 'none'),	
						type: req.body.format == 'jpg' ? 'jpeg' : req.body.format,
						fullPage: true
					});

					if (req.body.dpi != null && req.body.format == 'png')
					{
						data = writePngWithText(data, 'dpi', req.body.dpi);
					}
					
					if (req.body.embedXml == "1" && req.body.format == 'png')
					{
						data = writePngWithText(data, "mxGraphModel", xml, true,
								base64encoded);
					}
					else if (req.body.embedData == "1" && req.body.format == 'png')
					{
						data = writePngWithText(data, req.body.dataHeader, req.body.data, true,
								base64encoded);
					}
					else
					{
						if (base64encoded)
						{
							data = data.toString('base64');
						}

						if (data.length == 0)
						{
							throw new Error("Invalid image");
						}
					}

					if (req.body.filename != null)
					{
						logger.info("Filename in request " + req.body.filename);

						res.header('Content-disposition', 'attachment; filename="' + req.body.filename +
								'"; filename*=UTF-8\'\'' + req.body.filename);
					}
					
					res.header('Content-type', base64encoded? 'text/plain' : ('image/' + req.body.format));
					res.header("Content-Length", data.length);
					
					// These two parameters are for Google Docs or other recipients to transfer the real image width x height information
					// (in case this information is inaccessible or lost)
					res.header("content-ex-width", w);
					res.header("content-ex-height", h);
					
					if (pageId != null && pageId != 'undefined')
					{
						res.header("content-page-id", pageId);
					}

					if (scale != null && scale != 'undefined')
					{
						res.header("content-scale", scale);
					}

					res.end(data);

					var dt = Date.now() - t0;
					
					logger.info("Success " + reqStr + " dt=" + dt);
				}
				else if (req.body.format == 'pdf')
				{
					var from = req.body.allPages? 0 : parseInt(req.body.from || 0);
					var to = req.body.allPages? 1000 : parseInt(req.body.to || 1000) + 1; //The 'to' will be corrected later
					var pageId;
					var pdfs = [];

					for (var i = from; i < to; i++)
					{
						var info = await rederPage(i);
						pageId = info.pageId;
						to = to > info.pageCount? info.pageCount : to;
						await page.emulateMedia('screen');
						await page._emulationManager._client.send(
							'Emulation.setDefaultBackgroundColorOverride',
							{ color: { r: 0, g: 0, b: 0, a: 0 } }
						);
						pdfs.push(await page.pdf(info.pdfOptions));
					}

					var data = mergePdfs(pdfs, req.body.embedXml == '1' ? xml : null);

					if (req.body.filename != null)
					{
						res.header('Content-disposition', 'attachment; filename="' + req.body.filename +
								'"; filename*=UTF-8\'\'' + req.body.filename);
					}
					
					if (base64encoded)
					{
						data = data.toString('base64');
					}
					
					res.header('Content-type', base64encoded? 'text/plain' : 'application/pdf');
					res.header("Content-Length", data.length);
					
					if (pageId != null && pageId != 'undefined')
					{
						res.header("content-page-id", pageId);
					}

					res.end(data);

					var dt = Date.now() - t0;
					
					logger.info("Success " + reqStr + " dt=" + dt);
				}
				else 
				{
					//BAD_REQUEST
					res.status(400).end("Unsupported Format!");
					logger.warn("Unsupported Format: " + req.body.format);
				}
				await browser.close();
			}
			catch (e)
			{
				if (browser != null)
				{
					browser.close();
				}
				
				res.status(500).end("Error!");
				
				var ip = (req.headers['x-forwarded-for'] ||
							 req.connection.remoteAddress ||
							 req.socket.remoteAddress ||
							 req.connection.socket.remoteAddress).split(",")[0];
				
				var reqStr = "ip=" + ip + " ";

				if (req.body.format != null)
				{
					reqStr += ("format=" + req.body.format + " ");
				}

				if (req.body.w != null)
				{
					reqStr += ("w=" + req.body.w + " ");
				}

				if (req.body.h != null)
				{
					reqStr += ("h=" + req.body.h + " ");
				}

				if (req.body.scale != null)
				{
					reqStr += ("s=" + req.body.scale + " ");
				}

				if (req.body.bg != null)
				{
					reqStr += ("bg=" + req.body.bg + " ");
				}

				if (req.body.xmlData != null)
				{
					reqStr += ("xmlData=" + req.body.xmlData.length + " ");
				}

				logger.warn("Handled exception: " + e.message
						+ " req=" + reqStr, {stack: e.stack});
				
			}
		}
		else
		{
			res.status(400).end("BAD REQUEST");
		}
		//INTERNAL_SERVER_ERROR
		res.status(500).end("Unknown error!");
	  }
  }
  catch(e)
  {
	  logger.error(e.message, {stack: e.stack});
	  //INTERNAL_SERVER_ERROR
	  res.status(500).end("Unknown error");
  }
};

app.listen(PORT, function () 
{
  console.log(`draw.io export server listening on port ${PORT}...`);
});