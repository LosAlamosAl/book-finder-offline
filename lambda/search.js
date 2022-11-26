// If we're using Node 18.x we don't need to include JS SDK.

exports.handler = async (event, context) => {
  console.log(JSON.stringify(event));
  //  console.log(JSON.stringify(context));
  //  console.log(JSON.stringify(process.env));

  const b = JSON.parse(event.body);

  let ret = {
    isBase64Encoded: false,
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(b)
  };

  return ret;
};
