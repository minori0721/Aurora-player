(function(){
    const base = (window.API_BASE_URL ).replace(/\/$/, '');
    try{
        const pre = document.createElement('link');
        pre.rel = 'preconnect';
        pre.href = base;
        pre.crossOrigin = 'anonymous';
        document.head.appendChild(pre);
    }catch(e){}
    try{
        const host = base.replace(/^https?:\/\//, '');
        const dns = document.createElement('link');
        dns.rel = 'dns-prefetch';
        dns.href = '//' + host;
        document.head.appendChild(dns);
    }catch(e){}
})();
