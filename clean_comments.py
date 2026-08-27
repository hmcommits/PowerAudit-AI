import os
import re
from pathlib import Path

def clean_comments_in_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if filepath.endswith('.py'):
        # Aggressively shorten module docstrings at the top of the file
        def repl_docstring(match):
            doc = match.group(1).strip()
            lines = [line.strip() for line in doc.split('\n') if line.strip()]
            if not lines:
                return '"""Module for PowerAudit-AI operations."""\n'
            
            # Find first real sentence
            first_line = lines[0]
            if first_line.endswith('.py'):
                first_line = lines[1] if len(lines) > 1 else "Module for PowerAudit-AI operations."
                
            # If the line still has some "RocketRide..." fluff, clean it up
            first_line = re.sub(r'RocketRide Python Tool Node — ', '', first_line)
            
            return f'"""{first_line}"""\n'

        # Match """ at the very beginning of the string (allowing for whitespace)
        content = re.sub(r'^\s*\"\"\"(.*?)\"\"\"\n', repl_docstring, content, flags=re.DOTALL)
        
        # In case we missed some, replace other long docstrings that have INPUT/OUTPUT or large examples
        # with just the first line of the docstring.
        def repl_inner_docstring(match):
            doc = match.group(1).strip()
            lines = [line.strip() for line in doc.split('\n') if line.strip()]
            if not lines:
                return '""""""'
            return f'"""{lines[0]}"""'

        content = re.sub(r'\"\"\"(.*?INPUT.*?)\"\"\"', repl_inner_docstring, content, flags=re.DOTALL)
        
    elif filepath.endswith(('.js', '.jsx')):
        # JS files were mostly cleaned, but let's check for any long block comments /* ... */
        pass

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    base = Path('.')
    for root, _, files in os.walk(base):
        if 'node_modules' in root or '.git' in root or '__pycache__' in root or 'frontend' in root and 'dist' in root:
            continue
        for file in files:
            if file.endswith(('.py', '.js', '.jsx')):
                if file != 'clean_comments.py':
                    clean_comments_in_file(os.path.join(root, file))

if __name__ == '__main__':
    main()
