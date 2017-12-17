const express = require('express');
const bodyParser = require('body-parser');
const logger = require('morgan');
const compression = require('compression');
const puppeteer = require('puppeteer');
const PORT = process.env.PORT || 8000

const app = express();
logger('tiny');

//Max request size is 10 MB
app.use(bodyParser.urlencoded({ extended: false, limit: '10mb'}));
app.use(bodyParser.json({ limit: '10mb' }));

app.use(compression({
    threshold: 10,
}));


app.post('/', function (req, res) 
{
  if (req.body.format == null)
	  req.body.format = 'png';
  if (req.body.border == null) 
	  req.body.border = 0;
  
  (async () => {
	  const browser = await puppeteer.launch();
	  const page = await browser.newPage();
	  await page.goto('http://www.draw.io/export3.html', {waitUntil: 'networkidle2'});
	  
	  const result = await page.evaluate((body) => {
				return render({
					xml: decodeURIComponent(body.xml),
					format: body.format,
					w: body.w,
					h: body.h,
					border: body.border,
					bg: body.bg,
					"from": body["from"],
					to: body.to,
					scale: body.scale});
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
	  
	  if (req.body.format == 'png' || req.body.format == 'jpeg')
	  {
		  var data = await page.screenshot({
			  type: req.body.format,
			  fullPage: true
		  });
		  
		  res.header('Content-disposition', 'attachment; filename="' + decodeURIComponent(req.body.filename) + '"');
		  res.header('Content-type', 'image/' + req.body.format);
		  
		  res.end(data);
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
	  //await
	  browser.close();
  })();
});

app.listen(PORT, function () 
{
  console.log('pdf-export app listening on port ${ PORT }!')
});