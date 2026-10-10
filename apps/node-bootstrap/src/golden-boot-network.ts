// SPDX-License-Identifier: Apache-2.0
/** Executed on the owned freshly imaged BOOT volume. Only the default A entry changes. */
export const GOLDEN_GRUB_NETWORK_PYTHON = String.raw`import hashlib,json,os,re,stat,sys
reference,live,args_json,version=sys.argv[1:5]
args=json.loads(args_json)
if len(args) not in (1,2) or not re.fullmatch(r'ip=[0-9a-z.:/-]+',args[0]) or (len(args)==2 and not re.fullmatch(r'talos\.config\.early=[A-Za-z0-9+/=]+',args[1])):
    raise RuntimeError('golden_boot_network_arguments')
for directory in (reference,live):
    if os.path.islink(directory) or os.path.realpath(directory)!=directory:
        raise RuntimeError('golden_boot_network_path')
    for name in ('grub','A'):
        if os.path.islink(os.path.join(directory,name)):
            raise RuntimeError('golden_boot_network_path')
for name in ('A/vmlinuz','A/initramfs.xz'):
    hashes=[]
    for directory in (reference,live):
        path=os.path.join(directory,name)
        if os.path.islink(path) or not stat.S_ISREG(os.stat(path,follow_symlinks=False).st_mode):
            raise RuntimeError('golden_boot_network_path')
        digest=hashlib.sha256()
        with open(path,'rb') as source:
            while chunk:=source.read(1024*1024): digest.update(chunk)
        hashes.append(digest.digest())
    if hashes[0]!=hashes[1]: raise RuntimeError('golden_boot_kernel_changed')
base_path=os.path.join(reference,'grub/grub.cfg')
path=os.path.join(live,'grub/grub.cfg')
for candidate in (base_path,path):
    if os.path.islink(candidate) or not stat.S_ISREG(os.stat(candidate,follow_symlinks=False).st_mode) or os.stat(candidate).st_size>65536:
        raise RuntimeError('golden_boot_network_path')
with open(base_path,'r',encoding='utf-8',newline='') as source: base=source.read()
with open(path,'r',encoding='utf-8',newline='') as source: current=source.read()
title='A - Talos v'+version
default=re.findall(r'^set default="([^"]+)"$',base,re.M)
if default!=[title]: raise RuntimeError('golden_boot_default_changed')
entries=list(re.finditer(r'^menuentry "([^"]+)" \{$',base,re.M))
selected=[index for index,entry in enumerate(entries) if entry.group(1)==title]
if selected!=[0]: raise RuntimeError('golden_boot_default_changed')
start=entries[0].end()
end=entries[1].start() if len(entries)>1 else len(base)
body=base[start:end]
lines=list(re.finditer(r'^[ \t]*linux /A/vmlinuz[^\r\n]*$',body,re.M))
if len(lines)!=1 or 'talos.experimental.wipe=' in lines[0].group(0) or re.search(r'(?:^|\s)(?:ip=|talos\.config\.early=)',lines[0].group(0)):
    raise RuntimeError('golden_boot_default_changed')
position=start+lines[0].end()
target=base[:position]+' '+' '.join(args)+base[position:]
if current!=target:
    if current!=base: raise RuntimeError('golden_boot_network_changed')
    temporary=path+'.pgcf-network'
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    try:
        os.fchmod(fd,stat.S_IMODE(os.stat(path,follow_symlinks=False).st_mode))
        stream=os.fdopen(fd,'w',encoding='utf-8',newline='')
        fd=-1
        with stream as output:
            output.write(target); output.flush(); os.fsync(output.fileno())
        # One desired file, exact baseline/target readback, and an atomic same-filesystem replacement.
        os.replace(temporary,path)
        directory_fd=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
    finally:
        if fd>=0: os.close(fd)
with open(path,'r',encoding='utf-8',newline='') as source:
    if source.read()!=target: raise RuntimeError('golden_boot_network_readback')
print(hashlib.sha256(target.encode('utf-8')).hexdigest())
`;
