% Range / colon reads on a row vector — preserves orientation.
v = [10 20 30 40 50];
a = v(2:4); disp(a);
b = v(1:2:5); disp(b);
c = v(5:-1:1); disp(c);
d = v(2:end); disp(d);
e = v(end-2:end); disp(e);
f = v(:); disp(f);
% Range expressions referencing other variables
i = 2;
g = v(i:end); disp(g);
