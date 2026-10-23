from pathlib import Path
import shutil,datetime
root=Path.cwd(); source=Path(__file__).resolve().parent
files=[('sheldon_results.js','sheldon_results.js'),('templates/sheldon_sheet.ejs','templates/sheldon_sheet.ejs')]
for a,b in files:
 if not (root/b).exists(): raise SystemExit(f'Missing {b}. Run in Pressboxd root after installing Sheldon Results.')
for a,b in files:
 target=root/b;new=source/a
 if new.resolve()!=target.resolve():
  stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
  shutil.copy2(target,root/(b.replace('/','_')+'.bak_merges_'+stamp))
  shutil.copy2(new,target)
print('Sheldon Results merge/unmerge installed. Deploy sheldon_results.js and templates/sheldon_sheet.ejs.')
