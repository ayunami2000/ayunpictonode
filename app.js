const { WebSocket, WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

const prefix = "www";

let files = [];
let cache = {};

function throughDirectory(directory) {
  fs.readdirSync(directory).forEach(file => {
    const absolute = path.join(directory, file);
    if (fs.statSync(absolute).isDirectory()) return throughDirectory(absolute);
    else return files.push(absolute.toString().slice(prefix.length+1).replace(/\\/g,"/"));
  });
}

throughDirectory(prefix);

const server = require("http").createServer((req,res)=>{
  let url = req.url;
  if(url.startsWith("/"))url=url.slice(1);
  if(url=="")url = "index.html";
  if(files.includes(url)){
    res.writeHead(200,{"Content-Type":mime.contentType(url)});
    if(!(url in cache)){
      cache[url]=fs.readFileSync(prefix+"/"+url);
    }
    res.end(cache[url]);
  }else{
    res.writeHead(404,{"Content-Type":"text/plain"});
    res.end("404 Not Found");
  }
});

const wss = new WebSocketServer({ server });

let users=[];

let abusers=[];

let consperip={};

function playerChecks(data){
  return ("player" in data)&&("name" in data.player)&&("color" in data.player);
}

wss.on('connection', function(ws,req) {
  ws.playerData=null;
  let ip=req.headers['x-forwarded-for']||req.connection.remoteAddress;
  ip=ip.split(",",2)[0];
  if(!(ip in consperip))consperip[ip]=0;
  consperip[ip]++;
  if(consperip[ip]>5)return ws.close();
  let rate=0;
  let rateInterval=setInterval(()=>{
    if(rate>=10){
      abusers.push(ip);
      setTimeout(()=>{
        let ind=abusers.indexOf(ip);
        if(ind>-1){
          abusers.splice(ip,1);
        }
      },10000);
      ws.close();
    }else{
      rate=0;
    }
  },5000);
  ws.on('message', function message(data) {
    data=data.toString();
    if(data=="pong")return setTimeout(()=>ws!=null&&ws.readyState===WebSocket.OPEN&&ws.send("ping"),10000);
    rate++;
    try{
      data=JSON.parse(data);
      if(!("type" in data))return ws.close();
      switch(data.type){
        case "cl_verifyName":
          if(!playerChecks(data))return ws.close();
          data.player.name=data.player.name.replace(/[^A-Za-z0-9_]/g,"").slice(0,10);
          while(data.player.name.length==0)data.player.name=(""+Math.random()).slice(2);
          data.player.color=+data.player.color;
          if(isNaN(data.player.color)||data.player.color>16777215)data.player.color=0;
          ws.playerData=data.player;
          ws.send(JSON.stringify({type:"sv_nameVerified",player:ws.playerData}));
          ws.send(JSON.stringify({type:"sv_roomIds",count:[users.length],ids:[0]}));
          break;
        case "cl_joinRoom":
          if(ws.playerData==null)return ws.close();
          if(!(playerChecks(data)&&("id" in data)))return ws.close();
          //we ignore the player variable as it is not needed with the current method (it is also less secure if we were to use it)
          //for now, only one room, so dont check the id at all
          if(users.length>=16||abusers.includes(ip))return;
          if(users.includes(ws.playerData))return ws.close();
          if(users.some(p=>p.name==ws.playerData.name))return ws.close();
          //while(users.some(p=>p.name==ws.playerData.name)&&data.player.name.length==0)ws.playerData.name=(""+Math.random()).slice(2);//not sure if original pictochat allowed multiple of the same name buuuuut we will NOT
          users.push(ws.playerData);
          ws.send(JSON.stringify({type:"sv_roomData",id:0}));
          sendToOthers(ws,{type:"sv_playerJoined",player:ws.playerData,id:0});
          break;
        case "cl_sendMessage":
          if(ws.playerData==null)return ws.close();
          if(!(("message" in data)&&playerChecks(data.message)&&("textboxes" in data.message)&&Array.isArray(data.message.textboxes)&&("lines" in data.message)&&!isNaN(data.message.lines)&&data.message.lines<=5&&data.message.lines>0))return ws.close();
          for(let i=0;i<data.message.textboxes.length;i++){
            if("text" in data.message.textboxes[i]){
              data.message.textboxes[i].text=data.message.textboxes[i].text.slice(0,30);
            }
          }
          //todo: validate drawing
          data.type="sv_receivedMessage";
          data.message.player=ws.playerData;
          sendToOthers(ws,data);
          //abc
          break;
        case "cl_leaveRoom":
          if(ws.playerData==null)return ws.close();
          let ind=users.indexOf(ws.playerData);
          if(ind>-1){
            users.splice(ind,1);
            sendToOthers(ws,{type:"sv_playerLeft",player:ws.playerData,id:0});
          }
          break;
        default:
          ws.close();
      }
    }catch(e){
      ws.close();
    }
  });
  ws.on('close', function(){
    clearInterval(rateInterval);
    consperip[ip]=Math.max(0,consperip[ip]-1);
    if(ws.playerData!=null){
      let ind=users.indexOf(ws.playerData);
      if(ind>-1){
        users.splice(ind,1);
        sendToOthers(ws,{type:"sv_playerLeft",player:ws.playerData,id:0});
      }
    }
  });
});

function sendToOthers(ws,data,cond){
  if(!cond)cond=()=>true;
  wss.clients.forEach(w=>w.readyState===WebSocket.OPEN&&w.playerData!=null&&users.includes(w.playerData)&&w.playerData!=ws.playerData&&cond(w)&&w.send(JSON.stringify(data)));
}

server.listen(8080);