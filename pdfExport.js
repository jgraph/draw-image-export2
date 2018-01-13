const express = require('express');
const bodyParser = require('body-parser');
const logger = require('morgan');
const compression = require('compression');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
const fetch = require('node-fetch');
const crc = require('crc');

const MAX_AREA = 10000 * 10000;
const PNG_CHUNK_IDAT = 1229209940;
var DOMParser = require('xmldom').DOMParser;

const PORT = process.env.PORT || 8000

const app = express();
logger('tiny');

//Max request size is 10 MB
app.use(bodyParser.urlencoded({ extended: false, limit: '10mb'}));
app.use(bodyParser.json({ limit: '10mb' }));

app.use(compression({
    threshold: 10,
}));

// NOTE: Key length must not be longer than 79 bytes (not checked)
function writePngWithText(origBuff, key, text, compressed, base64encoded)
{
	var inOffset = 0;
	var outOffset = 0;
	var data = text;
	var dataLen = key.length + data.length + 1; //we add 1 zeros with non-compressed data
	
	//prepare compressed data to get its size
	if (compressed)
	{
		data = zlib.deflateRawSync(encodeURIComponent(text));
		//console.log(data.toString('base64'));
		dataLen = key.length + data.length + 2; //we add 2 zeros with compressed data
	}
	
	var outBuff = Buffer.allocUnsafe(origBuff.length + dataLen + 4); //4 is the header size "zTXt" or "tEXt"
	
	try
	{
		var magic1 = origBuff.readUInt32BE(inOffset);
		inOffset += 4;
		var magic2 = origBuff.readUInt32BE(inOffset);
		inOffset += 4;
		
		if (magic1 != 0x89504e47 && magic2 != 0x0d0a1a0a)
		{
			//TODO handle errors
			//throw new RuntimeException("PNGImageDecoder0");
			return;
		}
		
		outBuff.writeUInt32BE(magic1, outOffset);
		outOffset += 4;
		outBuff.writeUInt32BE(magic2, outOffset);
		outOffset += 4;
	}
	catch (e)
	{
		//TODO handle errors
		//throw new RuntimeException("PNGImageDecoder1");
		console.log(e);
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
				
				var typeSignature = (compressed) ? "zTXt" : "tEXt";
				outBuff.write(typeSignature, outOffset);
				
				outOffset += 4;
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

				var crcVal = crc.crc32(typeSignature);
				crc.crc32(data, crcVal);

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
		//TODO handle errors
		//throw e;
		console.log(e);
	}
}

app.post('/', handleRequest);
app.get('/', handleRequest);

//TODO add try catch to all await statements
async function handleRequest(req, res) 
{
  //Merge all parameters into body such that get and post works the same	
  Object.assign(req.body, req.params, req.query);
  
  // Checks for HTML export request
  if (req.body.html)
  {
	var html = req.body.html;
	//String referer = request.getHeader("referer");
	//logger.info("HTML export referer: " + referer);

	var wp = req.body.w;
	var w = (wp == null) ? 0 : parseInt(wp);

	var hp = req.body.h;
	var h = (hp == null) ? 0 : parseInt(hp);

	try
	{
		html = decodeURIComponent(
					zlib.inflateRawSync(
							new Buffer(decodeURIComponent(html), 'base64')).toString());
		
		// Poor man's certificate handler for images
		html = html.replace(/https\:\/\//g , "http://");
		
		
		const browser = await puppeteer.launch({
			headless: true,
			args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
		});
		const page = await browser.newPage();
		// https://github.com/GoogleChrome/puppeteer/issues/728
		await page.goto(`data:text/html,${html}`, {waitUntil: 'networkidle0'});
		//await page.setContent(html);

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
		//TODO handle errors!
		//logger.info("Inflate failed for HTML input: " + html);
		//throw e;
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
			console.log(e);
			//TODO handle errors!
			//logger.info("Inflate failed for XML input: " + req.body.xmldata);
			//throw e;
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
		try
		{
			//TODO enable loggign
			//String req = ((xml != null) ? "xml=" + xml.length() : "")
				//+ ((embedXml != null) ? " embed=" + embedXml : "") + " format="
				//+ outputFormat;
			req.body.xml = xml;

			const browser = await puppeteer.launch({
				headless: true,
				args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
			});
			const page = await browser.newPage();
			await page.goto('http://www.draw.io/export3.html', {waitUntil: 'networkidle0'});

			const result = await page.evaluate((body) => {
					return render({
						xml: body.xml,
						format: body.format,
						w: body.w,
						h: body.h,
						border: body.border || 0,
						bg: body.bg,
						"from": body["from"],
						to: body.to,
						scale: body.scale || 1
					});
				}, req.body);

			//default timeout is 30000 (30 sec)
			await page.waitForSelector('#LoadingComplete');

			var bounds = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('bounds'));

			var pdfOptions = {format: 'A4'};

			if (bounds != null)
			{
				bounds = JSON.parse(bounds);

				var w = Math.ceil(bounds.x + bounds.width);
				var h = Math.ceil(bounds.y + bounds.height);

				page.setViewport({width: w, height: h});

				pdfOptions = {
					width: w + 'px',
					height: (h + 1) + 'px',
					margin: {top: '0px', bottom: '0px', left: '0px', right: '0px'}
				}
			}	  

			// Cross-origin access should be allowed to now
			res.header("Access-Control-Allow-Origin", "*");
			
			req.body.filename = req.body.filename || ("export." + req.body.format);
			
			if (req.body.format == 'png' || req.body.format == 'jpeg')
			{
				var data = await page.screenshot({
					type: req.body.format,
					fullPage: true
				});

				var base64encoded = req.body.base64 == "1";

				if (req.body.embedXml == "1" && req.body.format == 'png')
				{
					data = writePngWithText(data, "mxGraphModel", xml, true,
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
						//TODO handle errors
						//throw new Exception("Invalid image");
					}
				}


				res.header('Content-disposition', 'attachment; filename="' + decodeURIComponent(req.body.filename) + '"');
				res.header('Content-type', base64encoded? 'text/plain' : ('image/' + req.body.format));
				res.header("Content-Length", data.length);

				res.end(data);

				//TODO handle errors
			  /*
			  if (result == 0)
				{
					logger.info("Success " + req + " dt=" + dt);
				}
				else
				{
					throw new Exception("Code " + result);
				}

				response.setStatus(HttpServletResponse.SC_OK);*/
			}
			else if (req.body.format == 'pdf')
			{
				var data = await page.pdf(pdfOptions);

				res.header('Content-disposition', 'attachment; filename="' + decodeURIComponent(req.body.filename) + '"');
				res.header('Content-type', 'application/pdf');

				res.end(data);
			}
			else 
			{
				res.end("Unsupported Format!");
			}
			await browser.close();
		}
		catch (e)
		{
			console.log(e);
			//TODO add logging
			/*response.setStatus(
					HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
			StringBuffer req = new StringBuffer(
					"ip=" + request.getRemoteAddr() + " ");

			if (outputFormat != null)
			{
				req.append("format=" + outputFormat + " ");
			}

			if (wp != null)
			{
				req.append("w=" + wp + " ");
			}

			if (hp != null)
			{
				req.append("h=" + hp + " ");
			}

			if (sp != null)
			{
				req.append("s=" + s + " ");
			}

			if (bg != null)
			{
				req.append("bg=" + bg + " ");
			}

			if (xmlData != null)
			{
				req.append("xmlData=" + xmlData.length() + " ");
			}

			logger.warning("Handled exception: " + e.getMessage()
					+ " req=" + req.toString());*/
		}
	}
	else
	{
		//TODO send bad request response
		//response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
	}
	res.end("Error!");
  }
};

app.listen(PORT, function () 
{
  console.log(`pdf-export app listening on port ${PORT}!`)
});